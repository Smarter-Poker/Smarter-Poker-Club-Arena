-- Private disposable recognition provider, source-reviewed only; SQL/native execution UNRUN.
-- Uses the existing session GUC spin_mixed_qualification.execution_uuid; no fallback namespace.
-- Preserved original recognition-restore.preimage-ee28c975.sql SHA256 ee28c975c686ed8e1a44b8ab9c8ba5acf89f37048618ee4919635956efbdd255
-- net-plan.json SHA256 2a0f15c69396fc10dd9e5b8137ba61bb819df8f1c00bc4ebd53e9f83eb808fbd; observed 2026-09-17T23:54:36.161853+00:00
-- recognizer.json SHA256 2c3ad8931db2aaef037cbb827da4ebac544e33768dd7a3754377175bfe771fdf; observed 2026-09-17T23:55:07.767797+00:00
-- period-requests.json SHA256 81a582b185e763782e68fc8fe24d3c9870c32e3d1266e8d31cdb45106312860d; observed 2026-09-17T23:55:58.583314+00:00
-- Exact captured financial bodies are restored, never invoked by these two catalog leaves.
-- Catalog equality/empty estate does not establish recognized zero-fee or fee-bearing financial qualification.
-- Positive-fee dependent authority remains separately owned; no missing dependency is stubbed here.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='1s';
SET LOCAL search_path=pg_catalog,public,pg_temp;
DO $guard$
DECLARE execution_uuid text:=current_setting('spin_mixed_qualification.execution_uuid',true);
 expected jsonb;actual jsonb;relation_name text;occupied boolean;
BEGIN
  IF session_user IS DISTINCT FROM 'postgres' OR current_user IS DISTINCT FROM 'postgres'
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses') IS DISTINCT FROM ''
     OR current_setting('session_replication_role') IS DISTINCT FROM 'origin'
     OR execution_uuid IS NULL
     OR execution_uuid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR current_database() IS DISTINCT FROM 'qual_spin_expiry_'||replace(execution_uuid,'-','') THEN
    RAISE EXCEPTION 'recognition catalog requires exact private PG17 Unix-socket allocation and postgres session' USING ERRCODE='55000';
  END IF;
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'recognition restore requires read committed'; END IF;
  FOREACH relation_name IN ARRAY ARRAY['accounting_routed_settlement_runs','accounting_tournament_fee_batches','accounting_tournament_fee_sources','accounting_tournament_fee_recognitions','accounting_tournament_recognized_sources','tournament_terminal_settlements']::text[] LOOP
    IF to_regclass('public.'||quote_ident(relation_name)) IS NULL THEN
      RAISE EXCEPTION 'recognition provider prerequisite relation missing: %',relation_name USING ERRCODE='55000';
    END IF;
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I)',relation_name) INTO occupied;
    IF occupied THEN RAISE EXCEPTION 'recognition provider requires empty estate: %',relation_name USING ERRCODE='55000'; END IF;
  END LOOP;
  IF to_regclass('public.accounting_period_recompute_requests') IS NOT NULL
     OR to_regprocedure('public.fn_accounting_tournament_fee_net_plan(uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_recognize_accounting_tournament_fees(uuid,timestamp with time zone,uuid,uuid,uuid)') IS NOT NULL
  THEN RAISE EXCEPTION 'recognition catalog requires absent new table and functions' USING ERRCODE='55000'; END IF;
END $guard$;
CREATE TABLE public.accounting_period_recompute_requests (
"id" uuid DEFAULT gen_random_uuid() NOT NULL,
"club_id" uuid NOT NULL,
"period_start" date NOT NULL,
"period_end" date NOT NULL,
"status" text DEFAULT 'pending'::text NOT NULL,
"reason" text,
"requested_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
"last_requested_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
"attempted_at" timestamp with time zone,
"attempts" bigint DEFAULT 0 NOT NULL,
"last_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
CONSTRAINT "accounting_period_recompute_r_club_id_period_start_period_e_key" UNIQUE (club_id, period_start, period_end),
CONSTRAINT "accounting_period_recompute_requests_check" CHECK (((EXTRACT(isodow FROM period_start) = (1)::numeric) AND (period_end = (period_start + 6)))),
CONSTRAINT "accounting_period_recompute_requests_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id),
CONSTRAINT "accounting_period_recompute_requests_pkey" PRIMARY KEY (id),
CONSTRAINT "accounting_period_recompute_requests_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'blocked'::text, 'complete'::text])))
);
CREATE INDEX accounting_period_recompute_requests_pending ON public.accounting_period_recompute_requests USING btree (period_start, club_id) WHERE (status <> 'complete'::text);
ALTER TABLE public.accounting_period_recompute_requests OWNER TO postgres;
ALTER TABLE public.accounting_period_recompute_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_period_recompute_requests NO FORCE ROW LEVEL SECURITY;
DO $acl$ DECLARE grantee text; BEGIN
 FOR grantee IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END
 FROM pg_class cl CROSS JOIN LATERAL aclexplode(COALESCE(cl.relacl,acldefault('r',cl.relowner))) x
 WHERE cl.oid='public.accounting_period_recompute_requests'::regclass LOOP
 EXECUTE 'REVOKE ALL ON TABLE public.accounting_period_recompute_requests FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END;
 END LOOP; END $acl$;
GRANT ALL ON TABLE public.accounting_period_recompute_requests TO postgres;
GRANT SELECT ON TABLE public.accounting_period_recompute_requests TO service_role;

-- Exact captured definition MD5 d8231a3f9219ecacb5ae68ee3aebe435
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
DO $acl$ DECLARE grantee text; BEGIN
 FOR grantee IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) x
 WHERE pr.oid=to_regprocedure('public.fn_accounting_tournament_fee_net_plan(uuid)') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_net_plan(uuid) FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END;
 END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_accounting_tournament_fee_net_plan(uuid) TO postgres;

-- Exact captured definition MD5 195878da781227b47753a28dbc7bc978
CREATE OR REPLACE FUNCTION public.fn_recognize_accounting_tournament_fees(p_tournament_id uuid, p_recognized_at timestamp with time zone, p_bank_club_id uuid, p_union_wallet_transaction_id uuid, p_bank_journal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE plan jsonb;prior record;source record;bank record;active_ids uuid[];refunded_ids uuid[];
 net_fee numeric;game_union uuid;rows_written int:=0;users_count int;source_count int;vip record;week_date date;
BEGIN
 IF p_recognized_at IS NULL OR p_recognized_at IS DISTINCT FROM transaction_timestamp() THEN
  RAISE EXCEPTION 'tournament_fee_original_recognition_transaction_required' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_tournament_recognition:'||p_tournament_id::text,0));
 PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,p_recognized_at);
 plan:=public.fn_accounting_tournament_fee_net_plan(p_tournament_id);
 SELECT * INTO prior FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=p_tournament_id;
 IF FOUND THEN
  IF prior.source_fingerprint IS DISTINCT FROM plan->>'source_fingerprint' THEN
   RAISE EXCEPTION 'recognized_tournament_fee_sources_changed' USING ERRCODE='23514'; END IF;
  RETURN prior.plan||jsonb_build_object('status',prior.status,'payable',prior.status='recognized','replayed',true,'recognized_at',prior.recognized_at);
 END IF;
 net_fee:=(plan->>'net_fee')::numeric;game_union:=NULLIF(plan->>'union_id','')::uuid;
 IF p_bank_club_id IS NULL AND net_fee>0 THEN RAISE EXCEPTION 'tournament_fee_bank_club_required' USING ERRCODE='23514'; END IF;
 PERFORM public.fn_accounting_tournament_bank_proof(p_tournament_id,p_recognized_at,p_bank_club_id,game_union,net_fee,p_union_wallet_transaction_id,p_bank_journal_id);
 SELECT COALESCE(array_agg(value::uuid),'{}') INTO active_ids FROM jsonb_array_elements_text(plan->'active_source_ids');
 SELECT COALESCE(array_agg(value::uuid),'{}') INTO refunded_ids FROM jsonb_array_elements_text(plan->'refunded_source_ids');
 INSERT INTO public.accounting_tournament_fee_recognitions(tournament_id,recognized_at,status,net_rake,union_id,bank_club_id,
  union_wallet_transaction_id,bank_journal_id,source_fingerprint,plan)
 VALUES(p_tournament_id,p_recognized_at,CASE WHEN net_fee>0 THEN 'recognized' ELSE 'cancelled' END,net_fee,game_union,p_bank_club_id,
  p_union_wallet_transaction_id,p_bank_journal_id,plan->>'source_fingerprint',plan);
 INSERT INTO public.accounting_tournament_recognized_sources(source_id,tournament_id,recognized_at,disposition,rake_credit)
 SELECT s.id,p_tournament_id,p_recognized_at,CASE WHEN s.id=ANY(active_ids) THEN 'earned' ELSE 'refunded' END,
  CASE WHEN s.id=ANY(active_ids) THEN s.rake_credit ELSE 0 END
 FROM public.accounting_tournament_fee_sources s WHERE s.id=ANY(active_ids||refunded_ids);
 FOR source IN SELECT * FROM public.accounting_tournament_fee_sources WHERE id=ANY(active_ids) ORDER BY club_id,player_id,id LOOP
  rows_written:=rows_written+public.fn_post_accounting_commission_source(source.id,'tournament_fee_accrual',p_recognized_at,source.contract);
  -- Statistics use the real source record/player pair. The source credit is
  -- recognized once; a retry is guarded by the terminal recognition row above.
  PERFORM public.apply_rakeback_player_stats(source.rake_record_id,source.player_id,source.club_id,0,source.rake_credit);
 END LOOP;
 -- VIP already has a unique event/player source key. Preserve its original
 -- settlement-time grouping while giving it exact conserved contributor cents.
 FOR vip IN SELECT player_id,sum(rake_credit) credit FROM public.accounting_tournament_fee_sources
  WHERE id=ANY(active_ids) GROUP BY player_id ORDER BY player_id LOOP
  IF vip.credit>0 THEN PERFORM public.fn_award_vip_credit(vip.player_id,vip.credit,'tournament_rake',p_tournament_id,'Tournament rake generated'); END IF;
 END LOOP;
 week_date:=(public.fn_union_week_start(p_recognized_at) AT TIME ZONE 'America/Los_Angeles')::date;
 INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end,status)
 SELECT DISTINCT club_id,week_date,week_date+6,'pending' FROM public.accounting_tournament_fee_sources WHERE id=ANY(active_ids)
 ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET status='pending',reason=NULL,last_result='{}'::jsonb,last_requested_at=transaction_timestamp();
 SELECT count(DISTINCT player_id),count(*) INTO users_count,source_count FROM public.accounting_tournament_fee_sources WHERE id=ANY(active_ids);
 RETURN plan||jsonb_build_object('status',CASE WHEN net_fee>0 THEN 'recognized' ELSE 'cancelled' END,
  'recognized_at',p_recognized_at,'payable',net_fee>0,'replayed',false,'commission_rows',rows_written,
  'attributed_users',users_count,'source_count',source_count,'attributed_chips',net_fee);
END $function$;
ALTER FUNCTION public.fn_recognize_accounting_tournament_fees(uuid,timestamp with time zone,uuid,uuid,uuid) OWNER TO postgres;
DO $acl$ DECLARE grantee text; BEGIN
 FOR grantee IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) x
 WHERE pr.oid=to_regprocedure('public.fn_recognize_accounting_tournament_fees(uuid,timestamp with time zone,uuid,uuid,uuid)') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_recognize_accounting_tournament_fees(uuid,timestamp with time zone,uuid,uuid,uuid) FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END;
 END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_recognize_accounting_tournament_fees(uuid,timestamp with time zone,uuid,uuid,uuid) TO postgres;
DO $verify$
DECLARE execution_uuid text:=current_setting('spin_mixed_qualification.execution_uuid',true);
 expected jsonb;actual jsonb;relation_name text;occupied boolean;
BEGIN
  IF session_user IS DISTINCT FROM 'postgres' OR current_user IS DISTINCT FROM 'postgres'
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses') IS DISTINCT FROM ''
     OR current_setting('session_replication_role') IS DISTINCT FROM 'origin'
     OR execution_uuid IS NULL
     OR execution_uuid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR current_database() IS DISTINCT FROM 'qual_spin_expiry_'||replace(execution_uuid,'-','') THEN
    RAISE EXCEPTION 'recognition catalog requires exact private PG17 Unix-socket allocation and postgres session' USING ERRCODE='55000';
  END IF;
  FOREACH relation_name IN ARRAY ARRAY['accounting_routed_settlement_runs','accounting_tournament_fee_batches','accounting_tournament_fee_sources','accounting_tournament_fee_recognitions','accounting_tournament_recognized_sources','tournament_terminal_settlements','accounting_period_recompute_requests']::text[] LOOP
    IF to_regclass('public.'||quote_ident(relation_name)) IS NULL THEN
      RAISE EXCEPTION 'recognition provider prerequisite relation missing: %',relation_name USING ERRCODE='55000';
    END IF;
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I)',relation_name) INTO occupied;
    IF occupied THEN RAISE EXCEPTION 'recognition provider requires empty estate: %',relation_name USING ERRCODE='55000'; END IF;
  END LOOP;
  expected:=$captured${"acl":"{postgres=arwdDxtm/postgres,service_role=r/postgres}","rls":true,"name":"accounting_period_recompute_requests","owner":"postgres","columns":[{"name":"id","type":"uuid","number":1,"default":"gen_random_uuid()","identity":"","not_null":true,"generated":""},{"name":"club_id","type":"uuid","number":2,"default":null,"identity":"","not_null":true,"generated":""},{"name":"period_start","type":"date","number":3,"default":null,"identity":"","not_null":true,"generated":""},{"name":"period_end","type":"date","number":4,"default":null,"identity":"","not_null":true,"generated":""},{"name":"status","type":"text","number":5,"default":"'pending'::text","identity":"","not_null":true,"generated":""},{"name":"reason","type":"text","number":6,"default":null,"identity":"","not_null":false,"generated":""},{"name":"requested_at","type":"timestamp with time zone","number":7,"default":"clock_timestamp()","identity":"","not_null":true,"generated":""},{"name":"last_requested_at","type":"timestamp with time zone","number":8,"default":"clock_timestamp()","identity":"","not_null":true,"generated":""},{"name":"attempted_at","type":"timestamp with time zone","number":9,"default":null,"identity":"","not_null":false,"generated":""},{"name":"attempts","type":"bigint","number":10,"default":"0","identity":"","not_null":true,"generated":""},{"name":"last_result","type":"jsonb","number":11,"default":"'{}'::jsonb","identity":"","not_null":true,"generated":""}],"indexes":["CREATE UNIQUE INDEX accounting_period_recompute_r_club_id_period_start_period_e_key ON public.accounting_period_recompute_requests USING btree (club_id, period_start, period_end)","CREATE INDEX accounting_period_recompute_requests_pending ON public.accounting_period_recompute_requests USING btree (period_start, club_id) WHERE (status <> 'complete'::text)","CREATE UNIQUE INDEX accounting_period_recompute_requests_pkey ON public.accounting_period_recompute_requests USING btree (id)"],"policies":null,"triggers":null,"force_rls":false,"constraints":[{"name":"accounting_period_recompute_r_club_id_period_start_period_e_key","validated":true,"definition":"UNIQUE (club_id, period_start, period_end)"},{"name":"accounting_period_recompute_requests_check","validated":true,"definition":"CHECK (((EXTRACT(isodow FROM period_start) = (1)::numeric) AND (period_end = (period_start + 6))))"},{"name":"accounting_period_recompute_requests_club_id_fkey","validated":true,"definition":"FOREIGN KEY (club_id) REFERENCES clubs(id)"},{"name":"accounting_period_recompute_requests_pkey","validated":true,"definition":"PRIMARY KEY (id)"},{"name":"accounting_period_recompute_requests_status_check","validated":true,"definition":"CHECK ((status = ANY (ARRAY['pending'::text, 'blocked'::text, 'complete'::text])))"}]}$captured$::jsonb;
  SELECT jsonb_build_object('name',cl.relname,'owner',pg_get_userbyid(cl.relowner),'acl',cl.relacl::text,
 'rls',cl.relrowsecurity,'force_rls',cl.relforcerowsecurity,
 'columns',(SELECT jsonb_agg(jsonb_build_object('name',at.attname,'type',format_type(at.atttypid,at.atttypmod),
   'number',at.attnum,'default',pg_get_expr(ad.adbin,ad.adrelid),'identity',at.attidentity,
   'not_null',at.attnotnull,'generated',at.attgenerated) ORDER BY at.attnum)
   FROM pg_attribute at LEFT JOIN pg_attrdef ad ON ad.adrelid=at.attrelid AND ad.adnum=at.attnum
   WHERE at.attrelid=cl.oid AND at.attnum>0 AND NOT at.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('name',co.conname,'validated',co.convalidated,
   'definition',pg_get_constraintdef(co.oid,false)) ORDER BY co.conname) FROM pg_constraint co WHERE co.conrelid=cl.oid),
 'indexes',(SELECT jsonb_agg(pg_get_indexdef(ix.indexrelid) ORDER BY ci.relname)
   FROM pg_index ix JOIN pg_class ci ON ci.oid=ix.indexrelid WHERE ix.indrelid=cl.oid),
 'policies',(SELECT CASE WHEN count(*)=0 THEN NULL::jsonb ELSE jsonb_build_object('unexpected_policy_count',count(*)) END
   FROM pg_policy po WHERE po.polrelid=cl.oid),
 'triggers',(SELECT CASE WHEN count(*)=0 THEN NULL::jsonb ELSE jsonb_build_object('unexpected_trigger_count',count(*)) END
   FROM pg_trigger tr WHERE tr.tgrelid=cl.oid AND NOT tr.tgisinternal))
 INTO actual FROM pg_class cl JOIN pg_namespace ns ON ns.oid=cl.relnamespace
 WHERE ns.nspname='public' AND cl.relname=expected->>'name' AND cl.relkind='r';
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'recognition period-request catalog differs from exact capture' USING ERRCODE='55000'; END IF;
  FOR expected IN SELECT value FROM jsonb_array_elements($captured$[{"acl":"{postgres=X/postgres}","kind":"f","owner":"postgres","config":["search_path=public"],"full_md5":"d8231a3f9219ecacb5ae68ee3aebe435","signature":"fn_accounting_tournament_fee_net_plan(uuid)","volatility":"s","security_definer":true},{"acl":"{postgres=X/postgres}","kind":"f","owner":"postgres","config":["search_path=public"],"full_md5":"195878da781227b47753a28dbc7bc978","signature":"fn_recognize_accounting_tournament_fees(uuid,timestamp with time zone,uuid,uuid,uuid)","volatility":"v","security_definer":true}]$captured$::jsonb) LOOP
    SELECT jsonb_build_object('signature',expected->>'signature','owner',pg_get_userbyid(pr.proowner),
 'acl',pr.proacl::text,'config',to_jsonb(pr.proconfig),'full_md5',md5(pg_get_functiondef(pr.oid)),
 'volatility',pr.provolatile,'security_definer',pr.prosecdef,'kind',pr.prokind)
 INTO actual FROM pg_proc pr WHERE pr.oid=to_regprocedure('public.'||(expected->>'signature'));
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'recognition function authority differs: %',expected->>'signature' USING ERRCODE='55000'; END IF;
  END LOOP;
END $verify$;
SELECT jsonb_build_object('stage','current_recognition_catalog_restore','execution_uuid',current_setting('spin_mixed_qualification.execution_uuid'),'database',current_database(),'catalog_matches_capture',true,'functions',2,'period_request_table_catalog_exact',true,'all_seven_catalog_relations_empty',true,'period_requests_relation_oid','public.accounting_period_recompute_requests'::regclass::oid,'source_capture_sha256',$captured${"net-plan.json":"2a0f15c69396fc10dd9e5b8137ba61bb819df8f1c00bc4ebd53e9f83eb808fbd","recognizer.json":"2c3ad8931db2aaef037cbb827da4ebac544e33768dd7a3754377175bfe771fdf","period-requests.json":"81a582b185e763782e68fc8fe24d3c9870c32e3d1266e8d31cdb45106312860d"}$captured$::jsonb,'full_qualification',false,'financial_qualification',false,'dependency_closure_proved',false) AS recognition_catalog_receipt;
COMMIT;
