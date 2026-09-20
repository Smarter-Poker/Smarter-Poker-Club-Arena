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
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='1s';
SET LOCAL search_path=pg_catalog,public,pg_temp;
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
SELECT jsonb_build_object('stage','current_recognition_catalog_readback','execution_uuid',current_setting('spin_mixed_qualification.execution_uuid'),'database',current_database(),'catalog_matches_capture',true,'functions',2,'period_request_table_catalog_exact',true,'all_seven_catalog_relations_empty',true,'period_requests_relation_oid','public.accounting_period_recompute_requests'::regclass::oid,'source_capture_sha256',$captured${"net-plan.json":"2a0f15c69396fc10dd9e5b8137ba61bb819df8f1c00bc4ebd53e9f83eb808fbd","recognizer.json":"2c3ad8931db2aaef037cbb827da4ebac544e33768dd7a3754377175bfe771fdf","period-requests.json":"81a582b185e763782e68fc8fe24d3c9870c32e3d1266e8d31cdb45106312860d"}$captured$::jsonb,'full_qualification',false,'financial_qualification',false,'dependency_closure_proved',false) AS recognition_catalog_receipt;
COMMIT;
