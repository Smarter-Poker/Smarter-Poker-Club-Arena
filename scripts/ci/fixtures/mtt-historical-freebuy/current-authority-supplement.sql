BEGIN; SET LOCAL search_path=public,extensions;
CREATE TABLE public.accounting_tournament_fee_batches("rake_record_id" uuid NOT NULL,"tournament_id" uuid NOT NULL,"source_fingerprint" text NOT NULL,"status" text DEFAULT 'captured'::text NOT NULL,"source_version" integer DEFAULT 2 NOT NULL,"source_manifest" jsonb,"rake_amount" numeric NOT NULL,"captured_at" timestamp with time zone DEFAULT transaction_timestamp() NOT NULL);
ALTER TABLE public.accounting_tournament_fee_batches ADD CONSTRAINT accounting_tournament_fee_batches_check CHECK (((status = 'legacy_unverified'::text) OR (jsonb_typeof(source_manifest) = 'object'::text)));
ALTER TABLE public.accounting_tournament_fee_batches ADD CONSTRAINT accounting_tournament_fee_batches_pkey PRIMARY KEY (rake_record_id);
ALTER TABLE public.accounting_tournament_fee_batches ADD CONSTRAINT accounting_tournament_fee_batches_rake_amount_check CHECK (((rake_amount > (0)::numeric) AND (rake_amount = round(rake_amount, 2)) AND ((rake_amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))));
ALTER TABLE public.accounting_tournament_fee_batches ADD CONSTRAINT accounting_tournament_fee_batches_rake_record_id_fkey FOREIGN KEY (rake_record_id) REFERENCES rake_records(id);
ALTER TABLE public.accounting_tournament_fee_batches ADD CONSTRAINT accounting_tournament_fee_batches_source_version_check CHECK ((source_version = 2));
ALTER TABLE public.accounting_tournament_fee_batches ADD CONSTRAINT accounting_tournament_fee_batches_status_check CHECK ((status = ANY (ARRAY['captured'::text, 'legacy_unverified'::text])));
ALTER TABLE public.accounting_tournament_fee_batches OWNER TO postgres;
REVOKE ALL ON TABLE public.accounting_tournament_fee_batches FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.accounting_tournament_fee_batches TO service_role;
ALTER TABLE public.accounting_tournament_fee_batches ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.accounting_tournament_fee_cutover("singleton" boolean DEFAULT true NOT NULL,"starts_at" timestamp with time zone NOT NULL);
ALTER TABLE public.accounting_tournament_fee_cutover ADD CONSTRAINT accounting_tournament_fee_cutover_pkey PRIMARY KEY (singleton);
ALTER TABLE public.accounting_tournament_fee_cutover ADD CONSTRAINT accounting_tournament_fee_cutover_singleton_check CHECK (singleton);
ALTER TABLE public.accounting_tournament_fee_cutover OWNER TO postgres;
REVOKE ALL ON TABLE public.accounting_tournament_fee_cutover FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.accounting_tournament_fee_cutover TO service_role;
ALTER TABLE public.accounting_tournament_fee_cutover ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.accounting_tournament_fee_sources("id" uuid DEFAULT gen_random_uuid() NOT NULL,"rake_record_id" uuid NOT NULL,"tournament_id" uuid NOT NULL,"player_id" uuid NOT NULL,"club_id" uuid NOT NULL,"union_id" uuid,"coordinator_union_id" uuid,"game_type" text NOT NULL,"registration_id" uuid NOT NULL,"source_charge_ledger_id" uuid NOT NULL,"source_entitlement_id" uuid NOT NULL,"charged_at" timestamp with time zone NOT NULL,"rake_credit" numeric NOT NULL,"contract" jsonb NOT NULL,"recorded_at" timestamp with time zone DEFAULT transaction_timestamp() NOT NULL);
ALTER TABLE public.accounting_tournament_fee_sources ADD CONSTRAINT accounting_tournament_fee_sources_pkey PRIMARY KEY (id);
ALTER TABLE public.accounting_tournament_fee_sources ADD CONSTRAINT accounting_tournament_fee_sources_rake_credit_check CHECK (((rake_credit >= (0)::numeric) AND (rake_credit = round(rake_credit, 2)) AND ((rake_credit)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))));
ALTER TABLE public.accounting_tournament_fee_sources ADD CONSTRAINT accounting_tournament_fee_sources_rake_record_id_fkey FOREIGN KEY (rake_record_id) REFERENCES accounting_tournament_fee_batches(rake_record_id);
ALTER TABLE public.accounting_tournament_fee_sources ADD CONSTRAINT accounting_tournament_fee_sources_rake_record_id_player_id_key UNIQUE (rake_record_id, player_id);
ALTER TABLE public.accounting_tournament_fee_sources ADD CONSTRAINT accounting_tournament_fee_sources_source_entitlement_id_key UNIQUE (source_entitlement_id);
ALTER TABLE public.accounting_tournament_fee_sources OWNER TO postgres;
REVOKE ALL ON TABLE public.accounting_tournament_fee_sources FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.accounting_tournament_fee_sources TO service_role;
ALTER TABLE public.accounting_tournament_fee_sources ENABLE ROW LEVEL SECURITY;
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
 SELECT array_agg(DISTINCT entity_key) INTO identities FROM public.accounting_agreement_history
  WHERE entity_type='agents' AND club_id=p_club_id AND subject_user_id=p_user_id AND observed_at<=p_at;
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
ALTER FUNCTION public.fn_accounting_agent_terms_at(uuid,uuid,timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_agent_terms_at(uuid,uuid,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_accounting_agent_terms_at(uuid,uuid,timestamp with time zone) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_accounting_earning_contract(p_club_id uuid, p_player_id uuid, p_rake numeric, p_game_union_id uuid, p_terms_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE member jsonb;agent jsonb;terms jsonb;chain jsonb;remaining numeric;rate numeric;amount numeric;
 seen uuid[];agent_id uuid;parent_id uuid;agent_user uuid;direct_user uuid;union_count int;coordinator_union uuid;union_agreement jsonb;union_house boolean;
BEGIN
 -- Private EXECUTE grants admit only trusted source owners, including the
 -- registration trigger running for a human. Public wrappers verify actors.
 IF p_club_id IS NULL OR p_player_id IS NULL OR p_terms_at IS NULL OR NOT isfinite(p_terms_at) OR p_terms_at>clock_timestamp()
  OR p_rake IS NULL OR p_rake<0 OR p_rake<>round(p_rake,2) OR p_rake::text IN('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'invalid_accounting_earning_contract' USING ERRCODE='22023'; END IF;
  SELECT count(*),(array_agg((uc.after_terms->>'union_id')::uuid))[1],
   (jsonb_agg(jsonb_build_object('history_id',uc.id,'observed_at',uc.observed_at,'terms',uc.after_terms)))->0
   INTO union_count,coordinator_union,union_agreement FROM (
    SELECT DISTINCT ON(h.entity_key) h.id,h.observed_at,h.after_terms FROM public.accounting_agreement_history h
     WHERE h.entity_type='union_clubs' AND h.club_id=p_club_id AND h.observed_at<=p_terms_at
     ORDER BY h.entity_key,h.observed_at DESC,h.id DESC) uc
    WHERE uc.after_terms IS NOT NULL AND uc.after_terms->>'club_id'=p_club_id::text;
  SELECT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_club_id AND c.is_union IS TRUE
   AND p_game_union_id IS NOT NULL AND (c.id=p_game_union_id OR c.union_id=p_game_union_id)) INTO union_house;
  IF union_house THEN coordinator_union:=p_game_union_id;union_agreement:=NULL; END IF;
  IF union_count>1 OR (p_game_union_id IS NOT NULL AND NOT union_house AND (union_count<>1 OR coordinator_union IS DISTINCT FROM p_game_union_id))
  THEN RAISE EXCEPTION 'cash_commission_earning_club_not_observed' USING ERRCODE='23514'; END IF;
  member:=public.fn_accounting_terms_at('club_members',p_club_id::text||':'||p_player_id::text,p_terms_at);
  terms:=member->'terms';
  IF terms IS NULL OR terms='null'::jsonb OR terms->>'club_id' IS DISTINCT FROM p_club_id::text OR terms->>'user_id' IS DISTINCT FROM p_player_id::text
   OR (terms->>'status' IS NULL OR terms->>'status' NOT IN('active','approved')) OR COALESCE((terms->>'is_active')::boolean,true)=false
  THEN RAISE EXCEPTION 'cash_commission_membership_not_active_at_earning' USING ERRCODE='23514'; END IF;
  direct_user:=NULLIF(terms->>'agent_id','')::uuid; agent:=NULL;
  IF direct_user IS NOT NULL THEN
   agent:=public.fn_accounting_agent_terms_at(p_club_id,direct_user,p_terms_at);
  ELSE
   BEGIN agent:=public.fn_accounting_agent_terms_at(p_club_id,p_player_id,p_terms_at);
   EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM IN('accounting_terms_not_observed','accounting_terms_not_active') THEN agent:=NULL; ELSE RAISE; END IF; END;
  END IF;
  remaining:=p_rake;chain:='[]';seen:=ARRAY[]::uuid[];
  WHILE agent IS NOT NULL AND agent->'terms' IS NOT NULL AND agent->'terms'<>'null'::jsonb LOOP
   terms:=agent->'terms'; agent_id:=(terms->>'id')::uuid;agent_user:=(terms->>'user_id')::uuid;
   IF agent_id IS NULL OR agent_user IS NULL OR agent_id=ANY(seen) OR cardinality(seen)>=64
    OR terms->>'club_id' IS DISTINCT FROM p_club_id::text OR terms->>'status' IS DISTINCT FROM 'active'
    OR terms->>'role' IS NULL OR terms->>'role' NOT IN('super_agent','agent','sub_agent')
   THEN RAISE EXCEPTION 'cash_commission_hierarchy_invalid_at_earning' USING ERRCODE='23514'; END IF;
   seen:=array_append(seen,agent_id);
   rate:=(terms->>'commission_rate')::numeric;
   IF rate>1 THEN rate:=rate/100; END IF;
   IF rate IS NULL OR rate<0 OR rate>1 OR rate::text IN('NaN','Infinity','-Infinity')
   THEN RAISE EXCEPTION 'cash_commission_rate_invalid_at_earning' USING ERRCODE='23514'; END IF;
   -- Preserve the installed agreement model: each upline rate applies to the
   -- remaining rake after the preceding tier. Round each payable to cents.
   amount:=round(remaining*rate,2);
   chain:=chain||jsonb_build_array(jsonb_build_object('agent_id',agent_id,'user_id',agent_user,
    'role',terms->>'role','depth',cardinality(seen),'rake_basis',p_rake,'remaining_basis',remaining,
    'rate',rate,'amount',amount,'agreement',agent));
   remaining:=remaining-amount;
   parent_id:=NULLIF(terms->>'parent_agent_id','')::uuid;
   IF parent_id IS NULL THEN agent:=NULL; ELSE agent:=public.fn_accounting_terms_at('agents',parent_id::text,p_terms_at); END IF;
  END LOOP;
 RETURN jsonb_build_object('player_id',p_player_id,'club_id',p_club_id,'union_id',p_game_union_id,
  'coordinator_union_id',coordinator_union,'rake_credit',p_rake,'membership',member,'tiers',chain,
  'club_residual',remaining,'union_agreement',union_agreement,'is_union_house',union_house,'terms_at',p_terms_at);
END $function$;
ALTER FUNCTION public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
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
 SELECT * INTO h FROM public.accounting_agreement_history
  WHERE entity_type=p_entity_type AND entity_key=p_entity_key AND observed_at<=p_at
  ORDER BY observed_at DESC,id DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_terms_not_observed' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('history_id',h.id,'observed_at',h.observed_at,'terms',h.after_terms);
END $function$;
ALTER FUNCTION public.fn_accounting_terms_at(text,text,timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_terms_at(text,text,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_accounting_terms_at(text,text,timestamp with time zone) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_fingerprint(p_row rake_records)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 -- Versioned economic fields are stable across unrelated schema additions.
 -- Tuple terminal markers are not economic source edits.
 SELECT md5(jsonb_object_agg(field,to_jsonb(p_row)->field ORDER BY field)::text)
 FROM unnest(ARRAY['id','hand_id','table_id','club_id','rake_amount','bbj_contribution','pot_size','num_players',
  'created_at','player_contributions','global_hand_id','is_tournament','tournament_id','source','metadata',
  'rake_method','returned_uncalled']::text[])field
$function$;
ALTER FUNCTION public.fn_accounting_tournament_fee_fingerprint(rake_records) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_fingerprint(rake_records) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_net_plan(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE refund_row record;raw_total numeric;positive_total numeric;refunded_total numeric:=0;expected numeric;raw_reference_sum numeric;
 positive_ids uuid[];negative_ids uuid[];processed uuid[]:='{}';refunded uuid[]:='{}';refs uuid[];direct_positive uuid[];
 pending uuid[];new_refunds uuid[];nested uuid[];covered uuid[];ref uuid;covered_ref uuid;
 refund_map jsonb:='{}';progress boolean;actual_union uuid;scope_count int;active_ids uuid[];refunded_ids uuid[];fingerprint text;
BEGIN
 IF p_tournament_id IS NULL THEN RAISE EXCEPTION 'tournament_required' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament
   AND (r.rake_amount IS NULL OR r.rake_amount<>round(r.rake_amount,2) OR r.rake_amount::text IN('NaN','Infinity','-Infinity') OR r.hand_id IS NOT NULL)) THEN
  RAISE EXCEPTION 'tournament_fee_source_invalid' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(array_agg(id ORDER BY id) FILTER(WHERE rake_amount>0),'{}'),
  COALESCE(array_agg(id ORDER BY id) FILTER(WHERE rake_amount<0),'{}'),COALESCE(sum(rake_amount),0),COALESCE(sum(rake_amount) FILTER(WHERE rake_amount>0),0)
 INTO positive_ids,negative_ids,raw_total,positive_total FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament;
 IF raw_total<0 THEN RAISE EXCEPTION 'tournament_fee_net_negative' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
   WHERE r.id=ANY(positive_ids) AND (b.status IS DISTINCT FROM 'captured' OR b.tournament_id IS DISTINCT FROM p_tournament_id
    OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
    OR b.rake_amount IS DISTINCT FROM r.rake_amount
    OR b.rake_amount IS DISTINCT FROM (SELECT sum(s.rake_credit) FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=r.id))) THEN
  RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=p_tournament_id AND NOT(s.rake_record_id=ANY(positive_ids))) THEN
  RAISE EXCEPTION 'tournament_fee_source_scope_changed' USING ERRCODE='23514'; END IF;
 SELECT count(DISTINCT COALESCE(union_id::text,'private')),(array_agg(union_id))[1] INTO scope_count,actual_union
  FROM public.accounting_tournament_fee_sources WHERE tournament_id=p_tournament_id;
 IF scope_count>1 THEN RAISE EXCEPTION 'tournament_fee_game_scope_changed' USING ERRCODE='23514'; END IF;
 pending:=negative_ids;
 WHILE cardinality(pending)>0 LOOP
  progress:=false;
  FOR refund_row IN SELECT * FROM public.rake_records WHERE id=ANY(pending) ORDER BY created_at,id LOOP
   IF refund_row.source NOT IN('fn_unregister_from_tournament','atomic_cancel_tournament') THEN
    RAISE EXCEPTION 'tournament_fee_refund_source_unsupported' USING ERRCODE='55000'; END IF;
   IF refund_row.metadata ? 'original_rake_record_ids' AND jsonb_typeof(refund_row.metadata->'original_rake_record_ids')='array' THEN
    SELECT array_agg(value::uuid ORDER BY value) INTO refs FROM jsonb_array_elements_text(refund_row.metadata->'original_rake_record_ids');
   ELSIF refund_row.metadata ? 'original_rake_record_id' THEN refs:=ARRAY[(refund_row.metadata->>'original_rake_record_id')::uuid];
   ELSE RAISE EXCEPTION 'tournament_fee_refund_source_ids_missing' USING ERRCODE='23514'; END IF;
   IF refs IS NULL OR cardinality(refs)=0 OR cardinality(refs)<>(SELECT count(DISTINCT x) FROM unnest(refs)x)
    OR refund_row.id=ANY(refs) OR EXISTS(SELECT 1 FROM unnest(refs)x WHERE NOT(x=ANY(positive_ids||negative_ids))) THEN
    RAISE EXCEPTION 'tournament_fee_refund_source_ids_invalid' USING ERRCODE='23514'; END IF;
   SELECT COALESCE(array_agg(id) FILTER(WHERE rake_amount>0),'{}'),COALESCE(array_agg(id) FILTER(WHERE rake_amount<0),'{}'),sum(rake_amount)
    INTO direct_positive,nested,raw_reference_sum FROM public.rake_records WHERE id=ANY(refs);
   IF NOT(nested<@processed) THEN CONTINUE; END IF;
   covered:='{}';
   FOREACH ref IN ARRAY nested LOOP
    FOR covered_ref IN SELECT value::uuid FROM jsonb_array_elements_text(refund_map->ref::text) LOOP
     covered:=array_append(covered,covered_ref);
    END LOOP;
   END LOOP;
   IF NOT(covered<@direct_positive) THEN RAISE EXCEPTION 'tournament_fee_refund_dependency_incomplete' USING ERRCODE='23514'; END IF;
   IF EXISTS(SELECT 1 FROM unnest(direct_positive)x WHERE x=ANY(refunded) AND NOT(x=ANY(covered))) THEN
    RAISE EXCEPTION 'tournament_fee_refund_duplicates_prior_refund' USING ERRCODE='23514'; END IF;
   SELECT COALESCE(array_agg(x ORDER BY x),'{}') INTO new_refunds FROM unnest(direct_positive)x WHERE NOT(x=ANY(refunded));
   SELECT COALESCE(sum(rake_amount),0) INTO expected FROM public.rake_records WHERE id=ANY(new_refunds);
   IF expected<=0 OR expected IS DISTINCT FROM -refund_row.rake_amount OR raw_reference_sum IS DISTINCT FROM expected
    OR EXISTS(SELECT 1 FROM public.rake_records q WHERE q.id=ANY(refs) AND (q.club_id IS DISTINCT FROM refund_row.club_id
      OR (q.metadata->>'user_id' IS DISTINCT FROM refund_row.metadata->>'user_id')
      OR q.created_at>refund_row.created_at)) THEN
    RAISE EXCEPTION 'tournament_fee_refund_not_exact_full_sources' USING ERRCODE='23514'; END IF;
   -- A player refund needs its immutable unregistration or cancellation witness.
   -- Spin unwind uses the cancellation's exact reversal-id list and zero net.
   IF refund_row.source='fn_unregister_from_tournament' THEN
    IF NOT EXISTS(SELECT 1 FROM public.tournament_unregistration_receipts u WHERE u.tournament_id=p_tournament_id
      AND refund_row.id=ANY(u.fee_reversal_ids) AND refs<@u.fee_source_rake_record_ids
      AND u.user_id::text=refund_row.metadata->>'user_id') THEN
     RAISE EXCEPTION 'tournament_fee_refund_receipt_missing' USING ERRCODE='23514'; END IF;
   ELSE
    IF NOT EXISTS(SELECT 1 FROM public.tournament_cancellation_receipts c WHERE c.tournament_id=p_tournament_id
      AND refund_row.id=ANY(c.fee_reversal_ids) AND c.total_rake_after=0 AND c.fees_reversed=c.total_rake_before) THEN
     RAISE EXCEPTION 'tournament_fee_cancellation_receipt_missing' USING ERRCODE='23514'; END IF;
   END IF;
   refunded:=refunded||new_refunds;refunded_total:=refunded_total+expected;
   refund_map:=refund_map||jsonb_build_object(refund_row.id::text,to_jsonb(direct_positive));
   processed:=array_append(processed,refund_row.id);pending:=array_remove(pending,refund_row.id);progress:=true;
  END LOOP;
  IF NOT progress THEN RAISE EXCEPTION 'tournament_fee_refund_dependency_cycle' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF positive_total-refunded_total IS DISTINCT FROM raw_total THEN
  RAISE EXCEPTION 'tournament_fee_net_not_conserved' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(array_agg(id ORDER BY id) FILTER(WHERE NOT(rake_record_id=ANY(refunded))),'{}'),
  COALESCE(array_agg(id ORDER BY id) FILTER(WHERE rake_record_id=ANY(refunded)),'{}')
 INTO active_ids,refunded_ids FROM public.accounting_tournament_fee_sources WHERE tournament_id=p_tournament_id;
 SELECT md5(COALESCE(string_agg(public.fn_accounting_tournament_fee_fingerprint(r),':' ORDER BY r.id),'')) INTO fingerprint
  FROM public.rake_records r WHERE tournament_id=p_tournament_id AND is_tournament;
 RETURN jsonb_build_object('accounting_version',2,'status','proven','tournament_id',p_tournament_id,
  'source_fingerprint',fingerprint,'union_id',actual_union,'gross_fee',positive_total,'refunded_fee',refunded_total,
  'net_fee',raw_total,'active_source_ids',active_ids,'refunded_source_ids',refunded_ids,'payable',false);
END $function$;
ALTER FUNCTION public.fn_accounting_tournament_fee_net_plan(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_net_plan(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$BEGIN
 RAISE EXCEPTION 'accounting_tournament_fee_receipt_is_immutable' USING ERRCODE='55000';
END$function$;
ALTER FUNCTION public.fn_accounting_tournament_fee_receipt_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_receipt_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_commit_capture()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$BEGIN
 PERFORM public.fn_stamp_accounting_tournament_fee(NEW.id);RETURN NULL;
END$function$;
ALTER FUNCTION public.fn_accounting_tournament_fee_commit_capture() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_commit_capture() FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_capture_accounting_tournament_fee(p_rake_record_id uuid, p_manifest jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
 r public.rake_records%ROWTYPE; t record; previous record; cutoff timestamptz;
 manifest jsonb; item jsonb; contributors jsonb:='[]'; contract jsonb;
 e record; l record; tp record; source_type text; expected_kind text;
 player uuid; club uuid; registration uuid; ledger_id uuid; entitlement_id uuid;
 actual_union uuid; charged_at timestamptz; weight numeric; total_weight numeric:=0;
 total_cents bigint; floor_total bigint; remainder_cents bigint; credit numeric;
 allocated numeric:=0; seen_players uuid[]:='{}'; seen_entitlements uuid[]:='{}';
 fingerprint text; result_ids uuid[]:='{}'; new_id uuid; n integer; row_plan record;
BEGIN
 -- Private EXECUTE grants are the boundary: this owner-only helper also runs
 -- inside a legitimate authenticated human's original charge transaction.
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id FOR SHARE;
 IF NOT FOUND OR r.is_tournament IS DISTINCT FROM true OR r.tournament_id IS NULL
  OR r.hand_id IS NOT NULL OR r.rake_amount IS NULL OR r.rake_amount<=0
  OR r.rake_amount<>round(r.rake_amount,2) OR r.rake_amount::text IN('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'positive_chip_tournament_fee_required' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_tournament_fee:'||r.id::text,0));
 fingerprint:=public.fn_accounting_tournament_fee_fingerprint(r);
 SELECT * INTO previous FROM public.accounting_tournament_fee_batches WHERE rake_record_id=r.id;
 IF FOUND THEN
  IF previous.source_fingerprint IS DISTINCT FROM fingerprint THEN
   RAISE EXCEPTION 'captured_tournament_fee_source_changed' USING ERRCODE='23514';
  END IF;
  SELECT array_agg(id ORDER BY player_id),count(*),sum(rake_credit)
   INTO result_ids,n,allocated FROM public.accounting_tournament_fee_sources WHERE rake_record_id=r.id;
  IF n=0 OR allocated IS DISTINCT FROM previous.rake_amount THEN
   RAISE EXCEPTION 'captured_tournament_fee_incomplete' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('accounting_version',2,'status','captured','rake_record_id',r.id,
   'tournament_id',r.tournament_id,'source_ids',result_ids,'rake_credit',allocated,'replayed',true,'payable',false);
 END IF;
 SELECT starts_at INTO cutoff FROM public.accounting_tournament_fee_cutover WHERE singleton;
 IF cutoff IS NULL OR r.created_at<cutoff OR r.created_at IS DISTINCT FROM transaction_timestamp() THEN
  RAISE EXCEPTION 'tournament_fee_not_captured_by_original_producer' USING ERRCODE='55000';
 END IF;
 SELECT id,club_id,union_id,is_private,tournament_type INTO t FROM public.tournaments WHERE id=r.tournament_id FOR SHARE;
 IF NOT FOUND OR public.fn_poker_diamond_tournament(r.tournament_id) THEN
  RAISE EXCEPTION 'chip_tournament_fee_required' USING ERRCODE='23514';
 END IF;
 actual_union:=CASE WHEN t.is_private THEN NULL ELSE t.union_id END;
 manifest:=COALESCE(p_manifest,r.metadata->'accounting_fee_source');
 IF (p_manifest IS NULL AND r.metadata->>'accounting_source_version' IS DISTINCT FROM '2')
  OR jsonb_typeof(manifest) IS DISTINCT FROM 'object'
  OR NOT(manifest ? 'union_id')
  OR NULLIF(manifest->>'union_id','')::uuid IS DISTINCT FROM actual_union
  OR manifest->>'game_type' IS DISTINCT FROM lower(t.tournament_type)
  OR jsonb_typeof(manifest->'contributors') IS DISTINCT FROM 'array'
  OR jsonb_array_length(manifest->'contributors')=0
 THEN RAISE EXCEPTION 'tournament_fee_producer_manifest_required' USING ERRCODE='23514'; END IF;
 expected_kind:=CASE r.source
  WHEN 'fn_register_for_tournament' THEN 'tournament_entry_fee'
  WHEN 'fn_register_horse_for_tournament' THEN 'tournament_entry_fee'
  WHEN 'fn_award_satellite_seat' THEN 'satellite_seat_entry_fee'
  WHEN 'fn_register_for_tournament_with_ticket' THEN 'tournament_ticket_entry_fee'
  WHEN 'fn_spin_book_entry' THEN 'spin_rake'
  WHEN 'process_tournament_rebuy' THEN r.metadata->>'kind' END;
 IF expected_kind IS NULL OR r.metadata->>'kind' IS DISTINCT FROM expected_kind
  OR (r.source='process_tournament_rebuy' AND expected_kind NOT IN('tournament_rebuy_fee','tournament_reentry_fee'))
 THEN RAISE EXCEPTION 'tournament_fee_source_unsupported' USING ERRCODE='55000'; END IF;
 n:=jsonb_array_length(manifest->'contributors');
 IF (r.source='fn_spin_book_entry' AND n<>3) OR (r.source<>'fn_spin_book_entry' AND n<>1) THEN
  RAISE EXCEPTION 'tournament_fee_contributor_count_invalid' USING ERRCODE='23514';
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(manifest->'contributors') LOOP
  player:=(item->>'player_id')::uuid;club:=(item->>'club_id')::uuid;
  registration:=(item->>'registration_id')::uuid;ledger_id:=(item->>'charge_ledger_id')::uuid;
  entitlement_id:=(item->>'entitlement_id')::uuid;charged_at:=(item->>'charged_at')::timestamptz;
  weight:=(item->>'weight')::numeric;
  IF player IS NULL OR club IS NULL OR registration IS NULL OR ledger_id IS NULL OR entitlement_id IS NULL
   OR charged_at IS NULL OR NOT isfinite(charged_at) OR charged_at<cutoff OR charged_at>r.created_at
   OR weight IS NULL OR weight<=0 OR weight<>round(weight,2) OR weight::text IN('NaN','Infinity','-Infinity')
   OR player=ANY(seen_players) OR entitlement_id=ANY(seen_entitlements)
  THEN RAISE EXCEPTION 'tournament_fee_contributor_invalid' USING ERRCODE='23514'; END IF;
  seen_players:=array_append(seen_players,player);seen_entitlements:=array_append(seen_entitlements,entitlement_id);
  SELECT * INTO e FROM public.tournament_refund_entitlements WHERE id=entitlement_id;
  SELECT * INTO l FROM public.chip_ledger WHERE id=ledger_id;
  SELECT * INTO tp FROM public.tournament_players WHERE id=registration;
  IF e.id IS NULL OR l.id IS NULL OR tp.id IS NULL OR e.tournament_id IS DISTINCT FROM r.tournament_id
   OR e.user_id IS DISTINCT FROM player OR e.refund_wallet_club_id IS DISTINCT FROM club
   OR e.source_ledger_id IS DISTINCT FROM ledger_id OR e.created_at IS DISTINCT FROM charged_at
   OR tp.tournament_id IS DISTINCT FROM r.tournament_id OR tp.user_id IS DISTINCT FROM player OR tp.club_id IS DISTINCT FROM club
   OR l.created_at IS DISTINCT FROM charged_at OR l.amount IS DISTINCT FROM e.gross
  THEN RAISE EXCEPTION 'tournament_fee_charge_evidence_mismatch' USING ERRCODE='23514'; END IF;
  IF r.source='fn_spin_book_entry' THEN
   -- A Spin has one aggregate fee, three exact paid entries, and one immutable
   -- reserve contribution. Weights are paid entry amounts, never mutable rebuys.
   IF e.entitlement_kind IS DISTINCT FROM 'wallet_charge' OR e.charge_category IS DISTINCT FROM 'tournament_buyin'
    OR e.gross IS DISTINCT FROM weight OR l.from_type IS DISTINCT FROM 'player_wallet'
    OR l.from_entity_id IS DISTINCT FROM player OR l.to_type IS DISTINCT FROM 'prize_liability'
    OR l.to_entity_id IS DISTINCT FROM r.tournament_id OR l.club_id IS DISTINCT FROM club
    OR l.category IS DISTINCT FROM 'tournament_buyin'
    OR (r.player_contributions->>player::text)::numeric IS DISTINCT FROM weight
   THEN RAISE EXCEPTION 'spin_fee_charge_evidence_mismatch' USING ERRCODE='23514'; END IF;
  ELSE
   IF e.refund_fee IS DISTINCT FROM r.rake_amount OR weight IS DISTINCT FROM r.rake_amount
    OR r.metadata->>'user_id' IS DISTINCT FROM player::text
   THEN RAISE EXCEPTION 'tournament_fee_amount_evidence_mismatch' USING ERRCODE='23514'; END IF;
   IF r.source IN('fn_register_for_tournament','fn_register_horse_for_tournament','process_tournament_rebuy') THEN
    source_type:=CASE WHEN r.source='process_tournament_rebuy' THEN 'rebuy' ELSE 'tournament_buyin' END;
    IF e.entitlement_kind IS DISTINCT FROM 'wallet_charge' OR e.charge_category IS DISTINCT FROM source_type
     OR l.from_type IS DISTINCT FROM 'player_wallet' OR l.from_entity_id IS DISTINCT FROM player
     OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM r.tournament_id
     OR l.club_id IS DISTINCT FROM club OR l.category IS DISTINCT FROM source_type
     OR (r.source<>'process_tournament_rebuy' AND r.metadata->>'registration_id' IS DISTINCT FROM registration::text)
    THEN RAISE EXCEPTION 'tournament_fee_wallet_evidence_mismatch' USING ERRCODE='23514'; END IF;
   ELSIF r.source='fn_register_for_tournament_with_ticket' THEN
    IF e.entitlement_kind IS DISTINCT FROM 'tournament_ticket' OR e.registration_id IS DISTINCT FROM registration
     OR e.source_ticket_id IS NULL OR r.metadata->>'ticket_id' IS DISTINCT FROM e.source_ticket_id::text
     OR r.metadata->>'registration_id' IS DISTINCT FROM registration::text
     OR l.from_type IS DISTINCT FROM 'escrow' OR l.from_entity_id IS DISTINCT FROM e.source_ticket_id
     OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM r.tournament_id
     OR l.category IS DISTINCT FROM 'ticket_redeem'
    THEN RAISE EXCEPTION 'tournament_fee_ticket_evidence_mismatch' USING ERRCODE='23514'; END IF;
   ELSE
    IF e.entitlement_kind IS DISTINCT FROM 'satellite_seat' OR e.registration_id IS DISTINCT FROM registration
     OR e.source_satellite_id IS NULL OR r.metadata->>'satellite_id' IS DISTINCT FROM e.source_satellite_id::text
     OR r.metadata->>'registration_id' IS DISTINCT FROM registration::text
     OR l.from_type IS DISTINCT FROM 'prize_liability' OR l.from_entity_id IS DISTINCT FROM e.source_satellite_id
     OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM r.tournament_id
     OR l.category IS DISTINCT FROM 'tournament_buyin'
    THEN RAISE EXCEPTION 'tournament_fee_satellite_evidence_mismatch' USING ERRCODE='23514'; END IF;
   END IF;
  END IF;
  contributors:=contributors||jsonb_build_array(item);total_weight:=total_weight+weight;
 END LOOP;
 IF r.source='fn_spin_book_entry' THEN
  IF jsonb_typeof(r.player_contributions) IS DISTINCT FROM 'object'
   OR (SELECT count(*) FROM jsonb_object_keys(r.player_contributions))<>3
   OR (SELECT count(DISTINCT (x->>'weight')::numeric) FROM jsonb_array_elements(contributors)x)<>1
   OR NOT EXISTS(SELECT 1 FROM public.spin_reserve_ledger s
      WHERE s.id=(manifest->>'spin_reserve_id')::uuid AND s.tournament_id=r.tournament_id
       AND s.kind='contribution' AND s.seats=3 AND s.house_rake=r.rake_amount
       AND s.amount=total_weight-r.rake_amount AND s.buy_in=total_weight/3)
  THEN RAISE EXCEPTION 'spin_fee_reserve_evidence_mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 total_cents:=(r.rake_amount*100)::bigint;
 SELECT sum(floor(total_cents*(x->>'weight')::numeric/total_weight)) INTO floor_total FROM jsonb_array_elements(contributors)x;
 remainder_cents:=total_cents-floor_total;
 INSERT INTO public.accounting_tournament_fee_batches(rake_record_id,tournament_id,source_fingerprint,rake_amount,source_manifest)
  VALUES(r.id,r.tournament_id,fingerprint,r.rake_amount,manifest);
 -- Largest remainder; UUID order breaks exact fractional ties reproducibly.
 FOR row_plan IN
  SELECT x, floor(total_cents*(x->>'weight')::numeric/total_weight)
    +CASE WHEN row_number() OVER(ORDER BY total_cents*(x->>'weight')::numeric/total_weight
       -floor(total_cents*(x->>'weight')::numeric/total_weight) DESC,x->>'player_id')<=remainder_cents THEN 1 ELSE 0 END cents
   FROM jsonb_array_elements(contributors)x ORDER BY x->>'player_id'
 LOOP
  item:=row_plan.x;credit:=row_plan.cents/100.0;
  contract:=public.fn_accounting_earning_contract((item->>'club_id')::uuid,(item->>'player_id')::uuid,
    credit,actual_union,(item->>'charged_at')::timestamptz);
  IF contract->>'player_id' IS DISTINCT FROM item->>'player_id' OR contract->>'club_id' IS DISTINCT FROM item->>'club_id'
   OR (contract->>'rake_credit')::numeric IS DISTINCT FROM credit
   OR NULLIF(contract->>'union_id','')::uuid IS DISTINCT FROM actual_union
   OR (contract->>'terms_at')::timestamptz IS DISTINCT FROM (item->>'charged_at')::timestamptz
  THEN RAISE EXCEPTION 'tournament_fee_contract_scope_mismatch' USING ERRCODE='23514'; END IF;
  INSERT INTO public.accounting_tournament_fee_sources(rake_record_id,tournament_id,player_id,club_id,union_id,
   coordinator_union_id,game_type,registration_id,source_charge_ledger_id,source_entitlement_id,charged_at,rake_credit,contract)
  VALUES(r.id,r.tournament_id,(item->>'player_id')::uuid,(item->>'club_id')::uuid,actual_union,
   NULLIF(contract->>'coordinator_union_id','')::uuid,manifest->>'game_type',(item->>'registration_id')::uuid,
   (item->>'charge_ledger_id')::uuid,(item->>'entitlement_id')::uuid,(item->>'charged_at')::timestamptz,credit,contract)
  RETURNING id INTO new_id;
  result_ids:=array_append(result_ids,new_id);allocated:=allocated+credit;
 END LOOP;
 IF allocated IS DISTINCT FROM r.rake_amount THEN RAISE EXCEPTION 'tournament_fee_credit_not_conserved' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('accounting_version',2,'status','captured','rake_record_id',r.id,
  'tournament_id',r.tournament_id,'source_ids',result_ids,'rake_credit',allocated,'replayed',false,'payable',false);
END $function$;
ALTER FUNCTION public.fn_capture_accounting_tournament_fee(uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_capture_accounting_tournament_fee(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_stamp_accounting_tournament_fee(p_rake_record_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r public.rake_records%ROWTYPE;t record;e record;tp record;item record;reserve_id uuid;
 manifest jsonb;contributors jsonb:='[]';game_union uuid;expected_entitlement text;
 expected_category text;uid uuid;reg uuid;count_rows int;cutoff timestamptz;legacy boolean:=false;
BEGIN
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id FOR UPDATE;
 IF NOT FOUND OR NOT r.is_tournament OR r.rake_amount<=0 THEN
  RAISE EXCEPTION 'positive_chip_tournament_fee_required' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches WHERE rake_record_id=r.id) THEN
  IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches WHERE rake_record_id=r.id AND status='legacy_unverified') THEN
   RETURN jsonb_build_object('accounting_version',2,'status','legacy_unverified','rake_record_id',r.id,'payable',false);
  END IF;
  RETURN public.fn_capture_accounting_tournament_fee(r.id);
 END IF;
 SELECT starts_at INTO cutoff FROM public.accounting_tournament_fee_cutover WHERE singleton;
 IF r.created_at IS DISTINCT FROM transaction_timestamp() OR cutoff IS NULL OR r.created_at<cutoff THEN
  RAISE EXCEPTION 'tournament_fee_not_captured_by_original_producer' USING ERRCODE='55000'; END IF;
 SELECT id,club_id,union_id,is_private,tournament_type INTO t FROM public.tournaments WHERE id=r.tournament_id FOR SHARE;
 IF NOT FOUND OR public.fn_poker_diamond_tournament(r.tournament_id) THEN
  RAISE EXCEPTION 'chip_tournament_fee_required' USING ERRCODE='23514'; END IF;
 game_union:=CASE WHEN t.is_private THEN NULL ELSE t.union_id END;
 IF r.source='fn_spin_book_entry' THEN
  IF jsonb_typeof(r.player_contributions) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(r.player_contributions))<>3 THEN
   RAISE EXCEPTION 'spin_fee_exact_paid_contributors_required' USING ERRCODE='23514'; END IF;
  FOR item IN SELECT key::uuid player_id,value::numeric weight FROM jsonb_each_text(r.player_contributions) ORDER BY key LOOP
   SELECT * INTO tp FROM public.tournament_players WHERE tournament_id=r.tournament_id AND user_id=item.player_id;
   IF NOT FOUND OR tp.club_id IS NULL THEN RAISE EXCEPTION 'spin_fee_entry_club_missing' USING ERRCODE='23514'; END IF;
   SELECT count(*) INTO count_rows FROM public.tournament_refund_entitlements x
    WHERE x.tournament_id=r.tournament_id AND x.user_id=item.player_id AND x.entitlement_kind='wallet_charge'
     AND x.charge_category='tournament_buyin' AND x.created_at=tp.registered_at AND x.gross=item.weight;
   IF count_rows<>1 THEN RAISE EXCEPTION 'spin_fee_exact_charge_ambiguous' USING ERRCODE='23514'; END IF;
   SELECT * INTO e FROM public.tournament_refund_entitlements x
    WHERE x.tournament_id=r.tournament_id AND x.user_id=item.player_id AND x.entitlement_kind='wallet_charge'
     AND x.charge_category='tournament_buyin' AND x.created_at=tp.registered_at AND x.gross=item.weight;
   contributors:=contributors||jsonb_build_array(jsonb_build_object('player_id',e.user_id,'club_id',e.refund_wallet_club_id,
    'registration_id',tp.id,'charge_ledger_id',e.source_ledger_id,'entitlement_id',e.id,'charged_at',e.created_at,'weight',item.weight));
   legacy:=legacy OR e.created_at<cutoff;
  END LOOP;
  SELECT count(*) INTO count_rows FROM public.spin_reserve_ledger s WHERE s.tournament_id=r.tournament_id AND s.kind='contribution';
  IF count_rows<>1 THEN RAISE EXCEPTION 'spin_fee_exact_reserve_required' USING ERRCODE='23514'; END IF;
  SELECT id INTO reserve_id FROM public.spin_reserve_ledger s WHERE s.tournament_id=r.tournament_id AND s.kind='contribution';
 ELSE
  IF NOT COALESCE(r.metadata->>'user_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',false) THEN
   RAISE EXCEPTION 'tournament_fee_exact_player_required' USING ERRCODE='23514'; END IF;
  uid:=(r.metadata->>'user_id')::uuid;
  expected_entitlement:=CASE r.source WHEN 'fn_register_for_tournament' THEN 'wallet_charge'
   WHEN 'fn_register_horse_for_tournament' THEN 'wallet_charge' WHEN 'process_tournament_rebuy' THEN 'wallet_charge'
   WHEN 'fn_award_satellite_seat' THEN 'satellite_seat' WHEN 'fn_register_for_tournament_with_ticket' THEN 'tournament_ticket' END;
  expected_category:=CASE WHEN r.source='process_tournament_rebuy' THEN 'rebuy' ELSE 'tournament_buyin' END;
  IF expected_entitlement IS NULL THEN RAISE EXCEPTION 'tournament_fee_source_unsupported' USING ERRCODE='55000'; END IF;
  reg:=NULLIF(r.metadata->>'registration_id','')::uuid;
  IF reg IS NULL AND r.source='process_tournament_rebuy' THEN
   SELECT id INTO reg FROM public.tournament_players WHERE tournament_id=r.tournament_id AND user_id=uid;
  END IF;
  IF reg IS NULL THEN RAISE EXCEPTION 'tournament_fee_exact_registration_required' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO count_rows FROM public.tournament_refund_entitlements x
   WHERE x.tournament_id=r.tournament_id AND x.user_id=uid AND x.created_at=r.created_at AND x.refund_fee=r.rake_amount
    AND x.entitlement_kind=expected_entitlement
    AND (CASE WHEN expected_entitlement='wallet_charge' THEN x.charge_category=expected_category ELSE x.registration_id=reg END);
  IF count_rows<>1 THEN RAISE EXCEPTION 'tournament_fee_exact_charge_ambiguous' USING ERRCODE='23514'; END IF;
  SELECT * INTO e FROM public.tournament_refund_entitlements x
   WHERE x.tournament_id=r.tournament_id AND x.user_id=uid AND x.created_at=r.created_at AND x.refund_fee=r.rake_amount
    AND x.entitlement_kind=expected_entitlement
    AND (CASE WHEN expected_entitlement='wallet_charge' THEN x.charge_category=expected_category ELSE x.registration_id=reg END);
  contributors:=jsonb_build_array(jsonb_build_object('player_id',e.user_id,'club_id',e.refund_wallet_club_id,
   'registration_id',reg,'charge_ledger_id',e.source_ledger_id,'entitlement_id',e.id,'charged_at',e.created_at,'weight',r.rake_amount));
 END IF;
 IF legacy THEN
  INSERT INTO public.accounting_tournament_fee_batches(rake_record_id,tournament_id,source_fingerprint,rake_amount,status)
   VALUES(r.id,r.tournament_id,public.fn_accounting_tournament_fee_fingerprint(r),r.rake_amount,'legacy_unverified');
  RETURN jsonb_build_object('accounting_version',2,'status','legacy_unverified','rake_record_id',r.id,'payable',false);
 END IF;
 manifest:=jsonb_build_object('union_id',game_union,'game_type',lower(t.tournament_type),'contributors',contributors,'spin_reserve_id',reserve_id);
 -- Original tournament evidence may already be sealed by a satellite receipt.
 -- Capture its manifest on the accounting batch; never rewrite that raw row.
 BEGIN
  RETURN public.fn_capture_accounting_tournament_fee(r.id,manifest);
 EXCEPTION WHEN SQLSTATE '55000' THEN
  -- Missing observed agreement may not destroy a proved original fee charge.
  -- This subtransaction rolls back every contributor receipt before recording
  -- the entire batch as unavailable. No partial commission can become payable.
  IF SQLERRM NOT IN('accounting_terms_not_observed','accounting_terms_not_active') THEN RAISE; END IF;
  INSERT INTO public.accounting_tournament_fee_batches(rake_record_id,tournament_id,source_fingerprint,rake_amount,status,source_manifest)
   VALUES(r.id,r.tournament_id,public.fn_accounting_tournament_fee_fingerprint(r),r.rake_amount,'legacy_unverified',
    manifest||jsonb_build_object('capture_reason',SQLERRM));
  RETURN jsonb_build_object('accounting_version',2,'status','legacy_unverified','rake_record_id',r.id,'payable',false,'reason',SQLERRM);
 END;
END $function$;
ALTER FUNCTION public.fn_stamp_accounting_tournament_fee(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_stamp_accounting_tournament_fee(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER accounting_tournament_fee_batches_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_batches FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_batches_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_batches FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_cutover_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_cutover FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_cutover_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_cutover FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_sources_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_sources FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_sources_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_sources FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
COMMIT;
