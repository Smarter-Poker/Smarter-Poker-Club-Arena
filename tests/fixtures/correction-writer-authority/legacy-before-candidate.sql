\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Isolated actual captured baseline, before the full candidate.
-- Keep this psql connection through candidate and all successor fixture inputs.
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='3s';
SET LOCAL TimeZone='UTC';
SET LOCAL DateStyle='ISO,YMD';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
  OR current_setting('session_replication_role')<>'origin'
  OR to_regclass('public.ca_correction_request_intents_v1') IS NOT NULL
  OR md5(pg_get_functiondef('public.fn_ca_post_correction(text,uuid,text,uuid,numeric,text,uuid,bigint,uuid,uuid,jsonb)'::regprocedure))
      IS DISTINCT FROM '3fc1c871313940f2e93a82a022f2faff'
 THEN RAISE EXCEPTION 'isolated original correction predecessor required';END IF;
END $guard$;
CREATE FUNCTION pg_temp.cw_id(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
 SELECT ('e6360000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
CREATE FUNCTION pg_temp.cw_check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'correction writer fixture failed: %',label;END IF;
 RAISE NOTICE 'correction writer fixture passed: %',label;
END$$;
CREATE FUNCTION pg_temp.cw_actor(who uuid,role_name text DEFAULT 'service_role') RETURNS void LANGUAGE plpgsql AS $$BEGIN
 PERFORM set_config('request.jwt.claim.sub',COALESCE(who::text,''),true);
 PERFORM set_config('request.jwt.claim.role',role_name,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',who,'role',role_name)::text,true);
END$$;
CREATE FUNCTION pg_temp.cw_call(q jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.fn_ca_post_correction(q->>'from_type',(q->>'from_entity')::uuid,
  q->>'to_type',(q->>'to_entity')::uuid,(q->>'amount')::numeric,q->>'reason',
  (q->>'incident_id')::uuid,(q->>'write_failure_id')::bigint,
  (q->>'club_id')::uuid,(q->>'union_id')::uuid,
  CASE WHEN (q->>'metadata_sql_null')::boolean IS TRUE THEN NULL ELSE q->'metadata' END);
$$;
-- All public/private base roots, including dynamically added component36 intent.
-- auth is included too; sequence allocations are intentionally not row snapshots.
CREATE FUNCTION pg_temp.cw_book() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE r record;rows_json jsonb;result jsonb:='{}';BEGIN
 FOR r IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN('public','smarter_private','auth','operational_source_intake') AND c.relkind IN('r','p') AND NOT c.relispartition
  ORDER BY n.nspname,c.relname LOOP
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM %I.%I t',r.nspname,r.relname) INTO rows_json;
  result:=result||jsonb_build_object(r.nspname||'.'||r.relname,rows_json);
 END LOOP;RETURN result;
END$$;
CREATE FUNCTION pg_temp.cw_legacy_rows(leg uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
 SET search_path=pg_catalog,public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
 SELECT jsonb_build_object(
  'ledger',(SELECT to_jsonb(l) FROM public.chip_ledger l WHERE l.id=leg),
  'key_claim',(SELECT to_jsonb(k) FROM public.chip_ledger_idem k WHERE k.leg_id=leg),
  'invoices',(SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM public.settlement_invoices i WHERE i.source_ledger_id=leg),
  'deliveries',(SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.invoice_id,d.recipient_id),'[]'::jsonb) FROM public.accounting_invoice_deliveries d JOIN public.settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=leg),
  'messages',(SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM public.social_messages m JOIN public.accounting_invoice_deliveries d ON d.message_id=m.id JOIN public.settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=leg),
  'notices',(SELECT COALESCE(jsonb_agg(to_jsonb(n) ORDER BY n.id),'[]'::jsonb) FROM public.notifications n JOIN public.accounting_invoice_deliveries d ON d.notification_id=n.id JOIN public.settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=leg));
$$;
DO $temp$ DECLARE n name;BEGIN SELECT nspname INTO STRICT n FROM pg_namespace WHERE oid=pg_my_temp_schema();
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon,authenticated,service_role',n);END$temp$;
REVOKE ALL ON FUNCTION pg_temp.cw_book(),pg_temp.cw_legacy_rows(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_temp.cw_book(),pg_temp.cw_legacy_rows(uuid),pg_temp.cw_id(integer),
 pg_temp.cw_check(boolean,text),pg_temp.cw_actor(uuid,text),pg_temp.cw_call(jsonb) TO anon,authenticated,service_role;
CREATE TEMP TABLE correction_fixture_input(request jsonb NOT NULL) ON COMMIT PRESERVE ROWS;
CREATE TEMP TABLE correction_legacy_input(request jsonb NOT NULL) ON COMMIT PRESERVE ROWS;
CREATE TEMP TABLE correction_legacy_result(result jsonb NOT NULL) ON COMMIT PRESERVE ROWS;
CREATE TEMP TABLE correction_legacy_witness(request jsonb NOT NULL,result jsonb NOT NULL,ledger_id uuid NOT NULL,
 invoice_ids uuid[] NOT NULL,original_rows jsonb NOT NULL) ON COMMIT PRESERVE ROWS;
GRANT SELECT ON correction_fixture_input,correction_legacy_input,correction_legacy_witness TO anon,authenticated,service_role;
GRANT INSERT ON correction_legacy_result TO service_role;

-- Only starting identities/balances/references use replica. No correction,
-- key claim, invoice, delivery, notice or private intent is fabricated here.
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) SELECT pg_temp.cw_id(n) FROM generate_series(1,4)n;
INSERT INTO public.users(id,username) SELECT pg_temp.cw_id(n),'correction_writer_fixture_'||n FROM generate_series(1,4)n;
INSERT INTO public.profiles(id,username,display_name) SELECT pg_temp.cw_id(n),'correction_writer_fixture_'||n,'Correction Writer Fixture '||n FROM generate_series(1,4)n;
INSERT INTO public.clubs(id,club_id,name,owner_id,chip_treasury,is_union,asset)
 VALUES(pg_temp.cw_id(101),963601,'Correction Writer Fixture',pg_temp.cw_id(1),1000,false,'chips');
INSERT INTO public.club_members(club_id,user_id,role,status,is_active,membership_lifecycle_status,chip_balance)
 SELECT pg_temp.cw_id(101),pg_temp.cw_id(n),CASE n WHEN 1 THEN 'owner' ELSE 'player' END,'active',true,'active',100
 FROM generate_series(1,4)n;
INSERT INTO public.ca_drift_incidents(id,source,dedupe_key,discrepancy_amount)
 SELECT pg_temp.cw_id(300+n),'correction-writer-fixture','correction-writer-fixture:'||n,1 FROM generate_series(1,30)n;
INSERT INTO public.ca_ledger_write_failures(id,club_id,user_id,delta,sqlstate,message)
 SELECT 9636000+n,pg_temp.cw_id(101),pg_temp.cw_id(2),1,'XX000','Synthetic correction writer reference '||n FROM generate_series(1,3)n;
SET LOCAL session_replication_role=origin;
INSERT INTO correction_legacy_input(request) VALUES(jsonb_build_object(
 'from_type','club_treasury','from_entity',pg_temp.cw_id(101),'to_type','player_wallet','to_entity',pg_temp.cw_id(2),
 'amount','7.25','reason','Original predecessor correction retained for successor replay refusal',
 'incident_id',pg_temp.cw_id(301),'write_failure_id',NULL,'club_id',pg_temp.cw_id(101),'union_id',NULL,
 'metadata_sql_null',false,'metadata',jsonb_build_object('fixture','actual predecessor origin')));
INSERT INTO correction_fixture_input(request) SELECT request||jsonb_build_object('incident_id',pg_temp.cw_id(302),
 'amount','8.25','reason','Fresh successor correction used by the original owner fixture') FROM correction_legacy_input;
SELECT pg_temp.cw_actor(pg_temp.cw_id(1),'service_role');
SET LOCAL ROLE service_role;
-- Real predecessor execution and all captured origin triggers, not direct ledger seeding.
DO $legacy$ DECLARE q jsonb;r jsonb;l uuid;invoices uuid[];BEGIN
 SELECT request INTO STRICT q FROM correction_legacy_input;r:=pg_temp.cw_call(q);l:=(r->>'ledger_id')::uuid;
 PERFORM pg_temp.cw_check(r=jsonb_build_object('ok',true,'replayed',false,'ledger_id',l) AND l IS NOT NULL,'predecessor creates one real correction');
 INSERT INTO correction_legacy_result VALUES(r);
END$legacy$;
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
INSERT INTO correction_legacy_witness
 SELECT q.request,r.result,l.id,
  ARRAY(SELECT i.id FROM public.settlement_invoices i WHERE i.source_ledger_id=l.id ORDER BY i.id),pg_temp.cw_legacy_rows(l.id)
 FROM correction_legacy_input q CROSS JOIN correction_legacy_result r JOIN public.chip_ledger l ON l.id=(r.result->>'ledger_id')::uuid
 WHERE l.idempotency_key='correction:inc:'||(q.request->>'incident_id');
SELECT pg_temp.cw_check((SELECT count(*)=1 AND bool_and(cardinality(invoice_ids)=1 AND
 jsonb_array_length(original_rows->'deliveries')=2 AND jsonb_array_length(original_rows->'messages')=2
 AND jsonb_array_length(original_rows->'notices')=2) FROM correction_legacy_witness),
 'actual predecessor records one invoice and both original issuer/payee deliveries');
COMMIT;
