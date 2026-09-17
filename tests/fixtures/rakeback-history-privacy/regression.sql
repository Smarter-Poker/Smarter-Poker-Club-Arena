\set ON_ERROR_STOP on
-- UNRUN. Protected PostgreSQL 17 full-catalog fixture only, after candidate
-- through 161500. No auth/business helper is replaced; the temporary helper
-- below only raises when an actual caller SELECT produces a false assertion.
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='3s';
DO $prerequisite$ BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
  OR to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('auth.role()') IS NULL
  OR to_regprocedure('public.fn_club_weekly_accounting_summary(uuid)') IS NULL
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('anon','authenticated') AND
   (rolsuper OR rolbypassrls OR pg_has_role(rolname,'service_role','USAGE')))
 THEN RAISE EXCEPTION 'privacy regression requires the real isolated captured catalog and non-bypass API roles';END IF;
END $prerequisite$;
CREATE FUNCTION pg_temp.privacy_assert(ok boolean,label text) RETURNS void
 LANGUAGE plpgsql SECURITY INVOKER AS $$BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'privacy assertion failed: %',label;END IF;
 RAISE NOTICE 'privacy assertion passed: %',label;
END$$;
DO $temporary_access$ DECLARE temporary_schema name;BEGIN
 SELECT nspname INTO STRICT temporary_schema FROM pg_namespace WHERE oid=pg_my_temp_schema();
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon,authenticated,service_role',temporary_schema);
END $temporary_access$;
GRANT EXECUTE ON FUNCTION pg_temp.privacy_assert(boolean,text) TO anon,authenticated,service_role;

-- Only synthetic fixture construction disables triggers. These deliberately
-- seeded historical receipts do not claim that a payment or invoice ran.
-- All caller/RLS/summary probes below run with actual origin behavior restored.
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id)
 SELECT ('e6150000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,6)n;
INSERT INTO public.users(id,username)
 SELECT ('e6150000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'privacy_payee_'||n FROM generate_series(1,6)n;
INSERT INTO public.profiles(id,username,display_name)
 SELECT ('e6150000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'privacy_payee_'||n,'Privacy Payee '||n FROM generate_series(1,6)n;
INSERT INTO public.clubs(id,club_id,name,owner_id,chip_treasury) VALUES
 ('e6151000-0000-4000-8000-000000000001',961501,'Privacy Club One','e6150000-0000-4000-8000-000000000001',0),
 ('e6151000-0000-4000-8000-000000000002',961502,'Privacy Club Two','e6150000-0000-4000-8000-000000000003',0);
INSERT INTO public.club_members(club_id,user_id,role,status,is_active,membership_lifecycle_status,chip_balance)
 SELECT 'e6151000-0000-4000-8000-000000000001'::uuid,
  ('e6150000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  CASE WHEN n=1 THEN 'owner' ELSE 'player' END,CASE WHEN n=4 THEN 'inactive' ELSE 'active' END,
  n<>4,CASE WHEN n=4 THEN 'departed' ELSE 'active' END,0 FROM generate_series(1,4)n;
INSERT INTO public.club_members(club_id,user_id,role,status,is_active,membership_lifecycle_status,chip_balance)
 VALUES('e6151000-0000-4000-8000-000000000002','e6150000-0000-4000-8000-000000000003','owner','active',true,'active',0);
-- Payee 2 has history at two clubs, with no current membership in club two.
-- Payee 5 has history but no remaining membership anywhere. Payee 6 has none.
INSERT INTO public.rakeback_periods(id,user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_amount,rakeback_earned,status)
 SELECT ('e6152000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('e6150000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'e6151000-0000-4000-8000-000000000001','2026-08-31','2026-09-06',100,.10,10,10,'paid'
 FROM generate_series(1,5)n;
INSERT INTO public.rakeback_periods(id,user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_amount,rakeback_earned,status) VALUES
 ('e6152000-0000-4000-8000-000000000006','e6150000-0000-4000-8000-000000000002','e6151000-0000-4000-8000-000000000002','2026-08-31','2026-09-06',100,.10,10,10,'paid'),
 ('e6152000-0000-4000-8000-000000000007',NULL,'e6151000-0000-4000-8000-000000000001','2026-08-24','2026-08-30',0,0,0,0,'pending');
INSERT INTO public.rakeback_period_payouts(id,rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at)
 SELECT ('e6153000-0000-4000-8000-'||right(p.id::text,12))::uuid,p.id,p.club_id,p.user_id,100,10,10,'paid','2026-09-07 10:00Z'
 FROM public.rakeback_periods p WHERE p.id BETWEEN 'e6152000-0000-4000-8000-000000000001' AND 'e6152000-0000-4000-8000-000000000006';
INSERT INTO public.settlement_periods(id,club_id,period_number,year,start_at,end_at,status)
 VALUES('e6154000-0000-4000-8000-000000000001','e6151000-0000-4000-8000-000000000001',36,2026,'2026-08-31 07:00Z','2026-09-07 07:00Z','open');
SET LOCAL session_replication_role=origin;
SET LOCAL row_security=on;
SET LOCAL request.jwt.claim='';
SET LOCAL request.jwt.claim.role='authenticated';

-- Own history and another member's rows: actual table reads under actual role.
SET LOCAL request.jwt.claim.sub='e6150000-0000-4000-8000-000000000002';
SET LOCAL request.jwt.claims='{"sub":"e6150000-0000-4000-8000-000000000002","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.privacy_assert(current_user='authenticated' AND auth.uid()='e6150000-0000-4000-8000-000000000002' AND NOT public.fn_caller_is_engine(),'real authenticated request context');
SELECT pg_temp.privacy_assert((SELECT count(*)=2 AND bool_and(user_id=auth.uid()) FROM public.rakeback_periods WHERE club_id IN('e6151000-0000-4000-8000-000000000001','e6151000-0000-4000-8000-000000000002')),'member sees only own periods, including former-club history');
SELECT pg_temp.privacy_assert((SELECT count(*)=2 AND bool_and(user_id=auth.uid()) FROM public.rakeback_period_payouts WHERE club_id IN('e6151000-0000-4000-8000-000000000001','e6151000-0000-4000-8000-000000000002')),'member sees only own individual payout receipts');
SELECT pg_temp.privacy_assert(NOT EXISTS(SELECT 1 FROM public.rakeback_periods WHERE user_id='e6150000-0000-4000-8000-000000000003') AND NOT EXISTS(SELECT 1 FROM public.rakeback_period_payouts WHERE user_id='e6150000-0000-4000-8000-000000000003'),'explicit request for another member cannot bypass RLS');
DO $denied$ BEGIN
 BEGIN
  PERFORM public.fn_club_weekly_accounting_summary('e6154000-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'ordinary member reached club aggregate';
 EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM IS DISTINCT FROM 'club_accounting_not_authorised' THEN RAISE;END IF;
  RAISE NOTICE 'privacy assertion passed: real summary reader rejects ordinary member';
 END;
END $denied$;
RESET ROLE;

-- Inactive membership never expands reads but does not erase own history.
SET LOCAL request.jwt.claim.sub='e6150000-0000-4000-8000-000000000004';
SET LOCAL request.jwt.claims='{"sub":"e6150000-0000-4000-8000-000000000004","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.privacy_assert((SELECT count(*)=1 AND bool_and(user_id=auth.uid()) FROM public.rakeback_periods WHERE club_id='e6151000-0000-4000-8000-000000000001') AND (SELECT count(*)=1 AND bool_and(user_id=auth.uid()) FROM public.rakeback_period_payouts WHERE club_id='e6151000-0000-4000-8000-000000000001'),'inactive departed member retains only own history');
RESET ROLE;
SET LOCAL request.jwt.claim.sub='e6150000-0000-4000-8000-000000000005';
SET LOCAL request.jwt.claims='{"sub":"e6150000-0000-4000-8000-000000000005","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.privacy_assert((SELECT count(*)=1 AND bool_and(user_id=auth.uid()) FROM public.rakeback_periods WHERE club_id='e6151000-0000-4000-8000-000000000001') AND (SELECT count(*)=1 AND bool_and(user_id=auth.uid()) FROM public.rakeback_period_payouts WHERE club_id='e6151000-0000-4000-8000-000000000001'),'payee without any current membership retains only own history');
RESET ROLE;
SET LOCAL request.jwt.claim.sub='e6150000-0000-4000-8000-000000000006';
SET LOCAL request.jwt.claims='{"sub":"e6150000-0000-4000-8000-000000000006","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.privacy_assert(NOT EXISTS(SELECT 1 FROM public.rakeback_periods WHERE club_id='e6151000-0000-4000-8000-000000000001') AND NOT EXISTS(SELECT 1 FROM public.rakeback_period_payouts WHERE club_id='e6151000-0000-4000-8000-000000000001'),'unrelated nonmember sees no private history');
RESET ROLE;

-- Ownership gives the existing aggregate reader, not other payees' rows.
SET LOCAL request.jwt.claim.sub='e6150000-0000-4000-8000-000000000001';
SET LOCAL request.jwt.claims='{"sub":"e6150000-0000-4000-8000-000000000001","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.privacy_assert((SELECT count(*)=1 AND bool_and(user_id=auth.uid()) FROM public.rakeback_periods WHERE club_id='e6151000-0000-4000-8000-000000000001') AND (SELECT count(*)=1 AND bool_and(user_id=auth.uid()) FROM public.rakeback_period_payouts WHERE club_id='e6151000-0000-4000-8000-000000000001'),'club owner sees only their own individual rows');
DO $aggregate$ DECLARE report jsonb;BEGIN
 report:=public.fn_club_weekly_accounting_summary('e6154000-0000-4000-8000-000000000001');
 IF report->>'club_id' IS DISTINCT FROM 'e6151000-0000-4000-8000-000000000001'
  OR NOT(report ?& ARRAY['rake_earned','rake_received','paid_super_agents','paid_agents','paid_sub_agents','paid_players'])
  OR report->>'status' IS DISTINCT FROM 'needs_reconciliation' OR report->>'ready_to_issue' IS DISTINCT FROM 'false'
  OR report ?| ARRAY['user_id','payees','players','payouts']
 THEN RAISE EXCEPTION 'authorized aggregate shape or uncertified history boundary changed: %',report;END IF;
 RAISE NOTICE 'privacy assertion passed: real authorized aggregate reader survives without raw individual access';
END $aggregate$;
RESET ROLE;

-- Even a subject-shaped value cannot grant the anonymous role a policy.
SET LOCAL request.jwt.claim.role='anon';
SET LOCAL request.jwt.claim.sub='e6150000-0000-4000-8000-000000000002';
SET LOCAL request.jwt.claims='{"sub":"e6150000-0000-4000-8000-000000000002","role":"anon"}';
SET LOCAL ROLE anon;
SELECT pg_temp.privacy_assert(NOT EXISTS(SELECT 1 FROM public.rakeback_periods WHERE club_id IN('e6151000-0000-4000-8000-000000000001','e6151000-0000-4000-8000-000000000002')) AND NOT EXISTS(SELECT 1 FROM public.rakeback_period_payouts WHERE club_id IN('e6151000-0000-4000-8000-000000000001','e6151000-0000-4000-8000-000000000002')),'anonymous role cannot read a payee even with a subject-shaped claim');
RESET ROLE;
SET LOCAL request.jwt.claim.role='authenticated';
SET LOCAL request.jwt.claim.sub='';
SET LOCAL request.jwt.claims='{"role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.privacy_assert(auth.uid() IS NULL AND NOT EXISTS(SELECT 1 FROM public.rakeback_periods WHERE club_id='e6151000-0000-4000-8000-000000000001') AND NOT EXISTS(SELECT 1 FROM public.rakeback_period_payouts WHERE club_id='e6151000-0000-4000-8000-000000000001'),'missing subject sees neither another payee nor null-user legacy rows');
RESET ROLE;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL ROLE service_role;
SELECT pg_temp.privacy_assert((SELECT count(*)=7 FROM public.rakeback_periods WHERE club_id IN('e6151000-0000-4000-8000-000000000001','e6151000-0000-4000-8000-000000000002')) AND (SELECT count(*)=6 FROM public.rakeback_period_payouts WHERE club_id IN('e6151000-0000-4000-8000-000000000001','e6151000-0000-4000-8000-000000000002')),'trusted service read remains available across these historical fixture records');
SELECT pg_temp.privacy_assert(NOT has_table_privilege(current_user,'public.rakeback_periods','INSERT,UPDATE,DELETE,TRUNCATE') AND NOT has_table_privilege(current_user,'public.rakeback_period_payouts','INSERT,UPDATE,DELETE,TRUNCATE'),'privacy change did not restore a direct service writer');
RESET ROLE;
ROLLBACK;
