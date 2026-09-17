-- SOURCE ONLY / UNRUN. Disposable PostgreSQL 17 fixture only.
-- Requires the actual full-weekly-accounting schema/auth/captured ACL fixture,
-- final weekly-v3 candidate and messenger-private-readers-candidate.sql.
-- No fake accounting/auth helpers, no production connection, no provider sends.
-- Synthetic empty historical books exercise the real canonical blocked reader;
-- they do not establish settlement, invoice delivery or financial reconciliation.
BEGIN;
CREATE FUNCTION pg_temp.check_weekly(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'weekly preview regression: %',label; END IF; END $f$;
DO $g$ DECLARE n text; BEGIN
 SELECT nspname INTO n FROM pg_namespace WHERE oid=pg_my_temp_schema();
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon,authenticated,service_role',n);
END $g$;
GRANT EXECUTE ON FUNCTION pg_temp.check_weekly(boolean,text) TO anon,authenticated,service_role;

SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) SELECT ('e6180000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,3)n;
INSERT INTO public.users(id,username) SELECT ('e6180000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'weekly_preview_'||n FROM generate_series(1,3)n;
INSERT INTO public.profiles(id,username,display_name) SELECT ('e6180000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'weekly_preview_'||n,'Weekly Preview '||n FROM generate_series(1,3)n;
INSERT INTO public.clubs(id,club_id,name,owner_id,chip_treasury) VALUES
 ('e6181000-0000-4000-8000-000000000001',961801,'Standalone Preview','e6180000-0000-4000-8000-000000000001',0),
 ('e6181000-0000-4000-8000-000000000002',961802,'Other Preview Club','e6180000-0000-4000-8000-000000000003',0);
INSERT INTO public.club_members(club_id,user_id,role,status,is_active,membership_lifecycle_status,chip_balance) VALUES
 ('e6181000-0000-4000-8000-000000000001','e6180000-0000-4000-8000-000000000001','owner','active',true,'active',0),
 ('e6181000-0000-4000-8000-000000000001','e6180000-0000-4000-8000-000000000002','admin','active',true,'active',0),
 ('e6181000-0000-4000-8000-000000000002','e6180000-0000-4000-8000-000000000003','owner','active',true,'active',0);
INSERT INTO public.settlement_periods(id,club_id,period_number,year,start_at,end_at,status) VALUES
 ('e6182000-0000-4000-8000-000000000001','e6181000-0000-4000-8000-000000000001',36,2026,'2026-08-31 07:00Z','2026-09-07 07:00Z','open'),
 ('e6182000-0000-4000-8000-000000000002','e6181000-0000-4000-8000-000000000002',36,2026,'2026-08-31 07:00Z','2026-09-07 07:00Z','open');
SET LOCAL session_replication_role=origin;
SET LOCAL row_security=on;
SET LOCAL request.jwt.claim.role='authenticated';
SET LOCAL request.jwt.claim.sub='e6180000-0000-4000-8000-000000000001';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"e6180000-0000-4000-8000-000000000001"}';
SET LOCAL ROLE authenticated;
DO $test$ DECLARE r jsonb; canonical jsonb; BEGIN
 PERFORM pg_temp.check_weekly(NOT public.fn_caller_is_engine(),'real authenticated caller is not engine');
 r:=public.fn_messenger_private_weekly_summary(auth.uid(),'e6181000-0000-4000-8000-000000000001','e6182000-0000-4000-8000-000000000001');
 canonical:=public.fn_club_weekly_accounting_summary('e6182000-0000-4000-8000-000000000001');
 PERFORM pg_temp.check_weekly(r->'contract_version'='1'::jsonb AND r->>'user_id'=auth.uid()::text,'receipt is actor-bound');
 PERFORM pg_temp.check_weekly(r->'summary'->>'scope_kind'='club' AND r->'summary'->>'scope_id'='e6181000-0000-4000-8000-000000000001'
   AND r->'summary'->'union_id'='null'::jsonb,'actual null-union period is standalone');
 PERFORM pg_temp.check_weekly(r->'summary'->>'status'='needs_reconciliation' AND r->'summary'->'ready_to_issue'='false'::jsonb
   AND r->'summary'->'run_status'='null'::jsonb,'empty uncertified book remains unresolved with unknown run');
 PERFORM pg_temp.check_weekly(r->'summary'->'rake_received'=canonical->'rake_received'
   AND r->'summary'->'total_paid_by_club'=canonical->'total_paid_by_club'
   AND r->'summary'->'retained_by_club'=canonical->'retained_by_club','amounts are forwarded unchanged from the real canonical reader');
 PERFORM pg_temp.check_weekly(NOT (r->'summary' ?| ARRAY['source_ledger_ids','private_bank_ledger_ids','source_fingerprint','tournament_quality']),
   'preview omits individual source identifiers and nested diagnostics');
 BEGIN
  PERFORM public.fn_messenger_private_weekly_summary('e6180000-0000-4000-8000-000000000002','e6181000-0000-4000-8000-000000000001','e6182000-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'forged actor accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM public.fn_messenger_private_weekly_summary(auth.uid(),'e6181000-0000-4000-8000-000000000001','e6182000-0000-4000-8000-000000000002');
  RAISE EXCEPTION 'other-club period accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $test$;
RESET ROLE;

-- An admin removed after the browser's earlier membership lookup cannot use
-- that stale flag. Check both role removal and inactive lifecycle independently.
-- These are fixture state changes, not staff-management transition proof.
SET LOCAL session_replication_role=replica;
UPDATE public.club_members SET role='player' WHERE club_id='e6181000-0000-4000-8000-000000000001' AND user_id='e6180000-0000-4000-8000-000000000002';
SET LOCAL session_replication_role=origin;
SET LOCAL request.jwt.claim.sub='e6180000-0000-4000-8000-000000000002';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"e6180000-0000-4000-8000-000000000002"}';
SET LOCAL ROLE authenticated;
DO $denied$ BEGIN BEGIN
 PERFORM public.fn_messenger_private_weekly_summary(auth.uid(),'e6181000-0000-4000-8000-000000000001','e6182000-0000-4000-8000-000000000001');
 RAISE EXCEPTION 'removed club representative accepted';
EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $denied$;
RESET ROLE;
SET LOCAL session_replication_role=replica;
UPDATE public.club_members SET role='admin',is_active=false,membership_lifecycle_status='departed'
 WHERE club_id='e6181000-0000-4000-8000-000000000001' AND user_id='e6180000-0000-4000-8000-000000000002';
SET LOCAL session_replication_role=origin;
SET LOCAL ROLE authenticated;
DO $denied$ BEGIN BEGIN
 PERFORM public.fn_messenger_private_weekly_summary(auth.uid(),'e6181000-0000-4000-8000-000000000001','e6182000-0000-4000-8000-000000000001');
 RAISE EXCEPTION 'inactive club representative accepted';
EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $denied$;
RESET ROLE;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claim.sub='';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL ROLE service_role;
DO $test$ BEGIN
 PERFORM pg_temp.check_weekly(public.fn_messenger_private_weekly_summary('e6180000-0000-4000-8000-000000000001',
  'e6181000-0000-4000-8000-000000000001','e6182000-0000-4000-8000-000000000001')->>'user_id'='e6180000-0000-4000-8000-000000000001','trusted API retains exact actor');
 BEGIN
  PERFORM public.fn_messenger_private_weekly_summary('e6180000-0000-4000-8000-000000000003','e6181000-0000-4000-8000-000000000001','e6182000-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'service bypass exposed another club summary';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
RESET ROLE;

-- Real canonical frozen-document branch, deliberately malformed historical
-- fixture; the wrapper must not trust a club ID alone or upgrade its version.
SET LOCAL session_replication_role=replica;
INSERT INTO public.settlement_invoices(id,club_id,period_id,invoice_type,invoice_number,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
 gross_amount,net_amount,deductions,status,message_sent,breakdown)
VALUES('e6184000-0000-4000-8000-000000000001','e6181000-0000-4000-8000-000000000001','e6182000-0000-4000-8000-000000000001',
 'club_weekly_accounting','FIXTURE-MALFORMED-WEEKLY','club','e6181000-0000-4000-8000-000000000001','club','e6181000-0000-4000-8000-000000000001',
 0,0,0,'generated',true,'{"accounting_version":2,"club_id":"e6181000-0000-4000-8000-000000000001","status":"complete"}');
SET LOCAL session_replication_role=origin;
SET LOCAL ROLE service_role;
DO $denied$ BEGIN BEGIN
 PERFORM public.fn_messenger_private_weekly_summary('e6180000-0000-4000-8000-000000000001','e6181000-0000-4000-8000-000000000001','e6182000-0000-4000-8000-000000000001');
 RAISE EXCEPTION 'legacy malformed frozen report certified';
EXCEPTION WHEN check_violation THEN NULL; END; END $denied$;
RESET ROLE;
SELECT pg_temp.check_weekly((SELECT p.provolatile='s' AND p.prosecdef AND p.proowner='postgres'::regrole
 FROM pg_proc p WHERE p.oid='public.fn_messenger_private_weekly_summary(uuid,uuid,uuid)'::regprocedure),'wrapper holds one STABLE snapshot');
SELECT pg_temp.check_weekly(NOT has_function_privilege('anon','public.fn_messenger_private_weekly_summary(uuid,uuid,uuid)','EXECUTE'),'anonymous cannot call wrapper');
ROLLBACK;
