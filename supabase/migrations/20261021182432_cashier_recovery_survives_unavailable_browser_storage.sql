-- 20261021182432_cashier_recovery_survives_unavailable_browser_storage
-- Reserved by scripts/reserve-migration-version.sh on October 21, 2026.
-- Classic, wallet-modal and Trade financial requests required a durable browser
-- write before calling their existing money RPC. Full/disabled browser storage
-- therefore refused legitimate transactions. Keep the unresolved exact envelope
-- in authenticated, actor-scoped PostgreSQL instead. No funds move here, no
-- unknown outcome expires, and existing money RPC/receipt authority is unchanged.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

CREATE TABLE public.cashier_browser_recoveries (
 actor_id uuid NOT NULL,
 club_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('wallet','transfer')),
 intent_key text NOT NULL CHECK(length(intent_key) BETWEEN 1 AND 160),
 identity uuid NOT NULL,
 envelope jsonb NOT NULL CHECK(jsonb_typeof(envelope)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_id,club_id,kind,intent_key),
 UNIQUE(actor_id,club_id,kind,identity)
);
ALTER TABLE public.cashier_browser_recoveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cashier_browser_recoveries FROM PUBLIC,anon,authenticated,service_role;

-- Match the client's recursive sorted compact JSON on its ASCII field/UUID
-- object keys. JSON string escaping and array order remain significant.
CREATE FUNCTION public.fn_cashier_browser_recovery_canonical(p_value jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $fn$
DECLARE v_result text;
BEGIN
 CASE jsonb_typeof(p_value)
 WHEN 'object' THEN
  SELECT '{'||coalesce(string_agg(to_jsonb(e.key)::text||':'||public.fn_cashier_browser_recovery_canonical(e.value),',' ORDER BY e.key COLLATE "C"),'')||'}'
  INTO v_result FROM jsonb_each(p_value) e;
 WHEN 'array' THEN
  SELECT '['||coalesce(string_agg(public.fn_cashier_browser_recovery_canonical(e.value),',' ORDER BY e.n),'')||']'
  INTO v_result FROM jsonb_array_elements(p_value) WITH ORDINALITY e(value,n);
 ELSE v_result:=p_value::text;
 END CASE;
 RETURN v_result;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_cashier_browser_recovery_canonical(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_cashier_browser_recovery_valid(
 p_actor_id uuid,p_club_id uuid,p_kind text,p_intent_key text,p_envelope jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $fn$
DECLARE v_identity text; v_targets jsonb; v_target text; v_failure jsonb; v_value jsonb; v_seen text[]:=ARRAY[]::text[];
 -- Operation identities accept every UUID shape; only the zero sentinel is invalid.
 v_uuid constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
 v_entity constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
 IF p_actor_id IS NULL OR p_club_id IS NULL OR p_actor_id='00000000-0000-0000-0000-000000000000'::uuid OR p_club_id='00000000-0000-0000-0000-000000000000'::uuid
 OR p_kind IS NULL OR p_kind NOT IN ('wallet','transfer') OR p_intent_key IS NULL OR length(p_intent_key)>160
 OR p_envelope IS NULL OR jsonb_typeof(p_envelope)<>'object' OR octet_length(p_envelope::text)>16777216
 OR p_envelope->'version' IS DISTINCT FROM '1'::jsonb
 OR p_envelope->>'userId' IS DISTINCT FROM p_actor_id::text OR p_envelope->>'clubId' IS DISTINCT FROM p_club_id::text
 OR jsonb_typeof(p_envelope->'createdAt') IS DISTINCT FROM 'number'
 OR (p_envelope->>'createdAt')::numeric<0 OR (p_envelope->>'createdAt')::numeric>1000000000000000 THEN RETURN false;END IF;
 IF p_kind='wallet' THEN
  IF p_envelope-ARRAY['version','userId','clubId','action','digest','operationId','createdAt']<>'{}'::jsonb
  OR p_envelope->>'action' IS NULL OR p_envelope->>'action' NOT IN ('fn_club_bank_send','fn_club_bank_claim_back','fn_agent_wallet_send','fn_agent_wallet_claim_back','fn_club_bank_reverse','fn_promo_wallet_send','fn_club_promo_wallet_send')
  OR coalesce(p_envelope->>'digest','')!~'^[0-9a-f]{64}$'
  OR p_intent_key IS DISTINCT FROM (p_envelope->>'action')||':'||(p_envelope->>'digest')
  OR coalesce(p_envelope->>'operationId','')!~*v_uuid OR p_envelope->>'operationId'='00000000-0000-0000-0000-000000000000' THEN RETURN false;END IF;
  RETURN true;
 END IF;
 IF p_intent_key!~'^[0-9a-f]{64}$'
 OR p_envelope-ARRAY['version','userId','clubId','kind','amount','targetIds','targetAmounts','failures','submissionId','opIds','destinations','source','ticketNote','tournamentId','createdAt']<>'{}'::jsonb
 OR coalesce(p_envelope->>'kind','') NOT IN ('send','ticket')
 OR coalesce(p_envelope->>'submissionId','')!~*v_uuid OR p_envelope->>'submissionId'='00000000-0000-0000-0000-000000000000'
 OR jsonb_typeof(p_envelope->'amount') IS DISTINCT FROM 'number'
 OR (p_envelope->>'amount')::numeric<=0 OR (p_envelope->>'amount')::numeric>1000000000
 OR (p_envelope->>'amount')::numeric<>round((p_envelope->>'amount')::numeric,2)
 OR jsonb_typeof(p_envelope->'targetIds') IS DISTINCT FROM 'array'
 OR jsonb_typeof(p_envelope->'failures') IS DISTINCT FROM 'array'
 OR jsonb_typeof(p_envelope->'opIds') IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 v_targets:=p_envelope->'targetIds';
 IF jsonb_array_length(v_targets) NOT BETWEEN 1 AND 10000
 OR jsonb_array_length(p_envelope->'failures') NOT BETWEEN 1 AND jsonb_array_length(v_targets) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_targets) t WHERE jsonb_typeof(t)<>'string') THEN RETURN false;END IF;
 FOR v_target IN SELECT jsonb_array_elements_text(v_targets) LOOP
  IF v_target!~*v_entity OR v_target='00000000-0000-0000-0000-000000000000' OR v_target=ANY(v_seen) THEN RETURN false;END IF;
  v_seen:=array_append(v_seen,v_target);
  IF p_envelope->>'kind'='send' AND (coalesce(p_envelope->'opIds'->>v_target,'')!~*v_uuid OR p_envelope->'opIds'->>v_target='00000000-0000-0000-0000-000000000000') THEN RETURN false;END IF;
 END LOOP;
 FOR v_target,v_value IN SELECT key,value FROM jsonb_each(p_envelope->'opIds') LOOP
  IF NOT(v_targets? v_target) OR jsonb_typeof(v_value)<>'string' OR trim(both '"' FROM v_value::text)!~*v_uuid OR trim(both '"' FROM v_value::text)='00000000-0000-0000-0000-000000000000' THEN RETURN false;END IF;
 END LOOP;
 IF p_envelope?'source' AND coalesce(p_envelope->>'source','') NOT IN ('agent_wallet','club_bank','promo_wallet','club_promo_wallet','player_wallet') THEN RETURN false;END IF;
 IF p_envelope?'ticketNote' AND p_envelope->>'ticketNote' IS DISTINCT FROM 'Cashier Ticket' THEN RETURN false;END IF;
 IF p_envelope?'tournamentId' AND (p_envelope->>'kind'<>'ticket' OR coalesce(p_envelope->>'tournamentId','')!~*v_entity OR p_envelope->>'tournamentId'='00000000-0000-0000-0000-000000000000') THEN RETURN false;END IF;
 IF p_envelope?'targetAmounts' THEN
  IF jsonb_typeof(p_envelope->'targetAmounts') IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(p_envelope->'targetAmounts'))<>jsonb_array_length(v_targets) THEN RETURN false;END IF;
  FOR v_target,v_value IN SELECT key,value FROM jsonb_each(p_envelope->'targetAmounts') LOOP
   IF NOT(v_targets? v_target) OR jsonb_typeof(v_value)<>'number' OR v_value::text::numeric<=0 OR v_value::text::numeric>1000000000 OR v_value::text::numeric<>round(v_value::text::numeric,2) THEN RETURN false;END IF;
  END LOOP;
 END IF;
 IF p_envelope?'destinations' THEN
  IF jsonb_typeof(p_envelope->'destinations') IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(p_envelope->'destinations'))<>jsonb_array_length(v_targets) THEN RETURN false;END IF;
  FOR v_target,v_value IN SELECT key,value FROM jsonb_each(p_envelope->'destinations') LOOP
   IF NOT(v_targets? v_target) OR jsonb_typeof(v_value)<>'string' OR trim(both '"' FROM v_value::text) NOT IN ('agent_wallet','player_wallet','promo_wallet') THEN RETURN false;END IF;
  END LOOP;
 END IF;
 v_seen:=ARRAY[]::text[];
 FOR v_failure IN SELECT jsonb_array_elements(p_envelope->'failures') LOOP
  v_target:=v_failure->>'userId';
  IF jsonb_typeof(v_failure)<>'object' OR v_failure-ARRAY['userId','name','message']<>'{}'::jsonb
  OR v_target IS NULL OR NOT(v_targets? v_target) OR v_target=ANY(v_seen)
  OR jsonb_typeof(v_failure->'name') IS DISTINCT FROM 'string' OR length(v_failure->>'name') NOT BETWEEN 1 AND 200
  OR jsonb_typeof(v_failure->'message') IS DISTINCT FROM 'string' OR length(v_failure->>'message') NOT BETWEEN 1 AND 500 THEN RETURN false;END IF;
  v_seen:=array_append(v_seen,v_target);
 END LOOP;
 RETURN p_intent_key=encode(sha256(convert_to(public.fn_cashier_browser_recovery_canonical(p_envelope-ARRAY['submissionId','opIds','failures','createdAt']),'UTF8')),'hex');
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_cashier_browser_recovery_valid(uuid,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_cashier_browser_recovery_reserve(p_actor_id uuid,p_club_id uuid,p_kind text,p_intent_key text,p_envelope jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_result jsonb; v_identity uuid;
BEGIN
 IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_actor_id THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Cashier Recovery Account Does Not Match';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.club_members cm WHERE cm.club_id=p_club_id AND cm.user_id=p_actor_id AND coalesce(cm.status,'active') IN ('active','approved'))
 OR coalesce(public.fn_club_cashier_scope(p_club_id,p_actor_id),'none')='none' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Active Cashier Access Is Required';END IF;
 IF NOT public.fn_cashier_browser_recovery_valid(p_actor_id,p_club_id,p_kind,p_intent_key,p_envelope) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid Cashier Recovery Envelope';END IF;
 v_identity:=(p_envelope->>CASE WHEN p_kind='wallet' THEN 'operationId' ELSE 'submissionId' END)::uuid;
 -- The actor/club/kind/business key serializes simultaneous tabs. Adopt the
 -- first readable legacy identity or draft and return that exact envelope.
 INSERT INTO public.cashier_browser_recoveries AS held(actor_id,club_id,kind,intent_key,identity,envelope)
 VALUES(p_actor_id,p_club_id,p_kind,p_intent_key,v_identity,p_envelope)
 ON CONFLICT(actor_id,club_id,kind,intent_key) DO UPDATE SET envelope=held.envelope
 RETURNING envelope INTO v_result;
 RETURN v_result;
END $fn$;

CREATE FUNCTION public.fn_cashier_browser_recovery_read(p_actor_id uuid,p_club_id uuid,p_kind text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_actor_id THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Cashier Recovery Account Does Not Match';END IF;
 IF p_club_id IS NULL OR p_kind IS NULL OR p_kind NOT IN ('wallet','transfer') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid Cashier Recovery Scope';END IF;
 SELECT coalesce(jsonb_agg(envelope ORDER BY created_at,intent_key),'[]'::jsonb) INTO v_result
 FROM public.cashier_browser_recoveries WHERE actor_id=p_actor_id AND club_id=p_club_id AND kind=p_kind;
 RETURN v_result;
END $fn$;

CREATE FUNCTION public.fn_cashier_browser_recovery_update(p_actor_id uuid,p_club_id uuid,p_kind text,p_intent_key text,p_identity uuid,p_envelope jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_original jsonb; v_identity uuid;
BEGIN
 IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_actor_id THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Cashier Recovery Account Does Not Match';END IF;
 SELECT envelope,identity INTO v_original,v_identity FROM public.cashier_browser_recoveries
 WHERE actor_id=p_actor_id AND club_id=p_club_id AND kind=p_kind AND intent_key=p_intent_key FOR UPDATE;
 IF NOT FOUND OR v_identity IS DISTINCT FROM p_identity THEN RETURN false;END IF;
 IF NOT public.fn_cashier_browser_recovery_valid(p_actor_id,p_club_id,p_kind,p_intent_key,p_envelope) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid Cashier Recovery Envelope';END IF;
 IF p_kind='wallet' THEN RETURN p_envelope=v_original;END IF;
 IF p_envelope-'failures' IS DISTINCT FROM v_original-'failures' THEN RETURN false;END IF;
 -- Compare against the CURRENT row under its lock. A stale tab can never
 -- reintroduce a target whose authoritative result another tab acknowledged.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_envelope->'failures') f
   WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_original->'failures') o WHERE o->>'userId'=f->>'userId')) THEN RETURN false;END IF;
 UPDATE public.cashier_browser_recoveries SET envelope=p_envelope
 WHERE actor_id=p_actor_id AND club_id=p_club_id AND kind=p_kind AND intent_key=p_intent_key AND identity=p_identity;
 RETURN true;
END $fn$;

CREATE FUNCTION public.fn_cashier_browser_recovery_ack(p_actor_id uuid,p_club_id uuid,p_kind text,p_intent_key text,p_identity uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_deleted integer;
BEGIN
 IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_actor_id THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Cashier Recovery Account Does Not Match';END IF;
 DELETE FROM public.cashier_browser_recoveries WHERE actor_id=p_actor_id AND club_id=p_club_id AND kind=p_kind AND intent_key=p_intent_key AND identity=p_identity;
 GET DIAGNOSTICS v_deleted=ROW_COUNT;
 RETURN v_deleted=1;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_cashier_browser_recovery_reserve(uuid,uuid,text,text,jsonb),public.fn_cashier_browser_recovery_read(uuid,uuid,text),public.fn_cashier_browser_recovery_update(uuid,uuid,text,text,uuid,jsonb),public.fn_cashier_browser_recovery_ack(uuid,uuid,text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cashier_browser_recovery_reserve(uuid,uuid,text,text,jsonb),public.fn_cashier_browser_recovery_read(uuid,uuid,text),public.fn_cashier_browser_recovery_update(uuid,uuid,text,text,uuid,jsonb),public.fn_cashier_browser_recovery_ack(uuid,uuid,text,text,uuid) TO authenticated;
COMMIT;
