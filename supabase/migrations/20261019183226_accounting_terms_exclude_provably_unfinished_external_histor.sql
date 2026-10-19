-- An observed row inside an external multi-row transaction was never a
-- separately committed agreement. A later observed row in that same transaction
-- proves it could not have committed at the earning instant. Keep the preceding
-- observed agreement rather than mixing its intermediate hierarchy updates.
-- No commit timestamp is inferred; historical rows and booked contracts stay intact.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_accounting_terms_at(text,text,timestamptz)'::regprocedure))<>'d262f82e6e75fc3e6830f75972e4b823'
 OR md5(pg_get_functiondef('public.fn_accounting_agent_terms_at(uuid,uuid,timestamptz)'::regprocedure))<>'eefa92172db730cfc9c739800d3bc12a'
 THEN RAISE EXCEPTION 'atomic_accounting_history_preimage_changed'; END IF;
END $guard$;
CREATE INDEX accounting_agreement_history_transaction_time ON public.accounting_agreement_history(transaction_id,observed_at);
CREATE OR REPLACE FUNCTION public.fn_accounting_terms_at(p_entity_type text, p_entity_key text, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE h public.accounting_agreement_history%ROWTYPE;
BEGIN
 -- Service-only EXECUTE ACL also permits private source-owner triggers.
 IF p_entity_type NOT IN('agents','club_members','union_clubs') OR p_entity_type IS NULL
    OR p_entity_key IS NULL OR p_entity_key='' OR p_at IS NULL OR NOT isfinite(p_at) OR p_at>transaction_timestamp()
 THEN RAISE EXCEPTION 'invalid_accounting_terms_request' USING ERRCODE='22023'; END IF;
 SELECT hist.* INTO h FROM public.accounting_agreement_history hist
  WHERE hist.entity_type=p_entity_type AND hist.entity_key=p_entity_key AND hist.observed_at<=p_at AND (hist.transaction_id=txid_current_if_assigned() OR NOT EXISTS(
   SELECT 1 FROM public.accounting_agreement_history later
   WHERE later.transaction_id=hist.transaction_id AND later.observed_at>p_at))
  ORDER BY hist.observed_at DESC,hist.id DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_terms_not_observed' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('history_id',h.id,'observed_at',h.observed_at,'terms',h.after_terms);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_accounting_agent_terms_at(p_club_id uuid, p_user_id uuid, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE identities text[]; identity_key text; v jsonb; result jsonb; active_count int:=0;
BEGIN
 -- Service-only EXECUTE ACL also permits private source-owner triggers.
 IF p_club_id IS NULL OR p_user_id IS NULL OR p_at IS NULL OR NOT isfinite(p_at) OR p_at>transaction_timestamp()
 THEN RAISE EXCEPTION 'invalid_accounting_terms_request' USING ERRCODE='22023'; END IF;
 -- Find candidate identities from history, then resolve each identity at the
 -- earning time. A later move/deletion closes the old identity; filtering the
 -- history by club before selecting its latest event would resurrect that row.
 SELECT array_agg(DISTINCT h.entity_key) INTO identities FROM public.accounting_agreement_history h
  WHERE h.entity_type='agents' AND h.club_id=p_club_id AND h.subject_user_id=p_user_id AND h.observed_at<=p_at AND (h.transaction_id=txid_current_if_assigned() OR NOT EXISTS(
   SELECT 1 FROM public.accounting_agreement_history later
   WHERE later.transaction_id=h.transaction_id AND later.observed_at>p_at));
 IF identities IS NULL THEN RAISE EXCEPTION 'accounting_terms_not_observed' USING ERRCODE='55000'; END IF;
 FOREACH identity_key IN ARRAY identities LOOP
  v:=public.fn_accounting_terms_at('agents',identity_key,p_at);
  IF v->'terms'->>'club_id'=p_club_id::text AND v->'terms'->>'user_id'=p_user_id::text
     AND v->'terms'->>'status'='active' THEN
   active_count:=active_count+1; result:=v;
  END IF;
 END LOOP;
 IF active_count=0 THEN RAISE EXCEPTION 'accounting_terms_not_active' USING ERRCODE='55000'; END IF;
 IF active_count>1 THEN RAISE EXCEPTION 'accounting_terms_ambiguous' USING ERRCODE='55000'; END IF;
 RETURN result;
END $function$;

REVOKE ALL ON FUNCTION public.fn_accounting_terms_at(text,text,timestamptz),public.fn_accounting_agent_terms_at(uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_terms_at(text,text,timestamptz),public.fn_accounting_agent_terms_at(uuid,uuid,timestamptz) TO service_role;
COMMIT;
