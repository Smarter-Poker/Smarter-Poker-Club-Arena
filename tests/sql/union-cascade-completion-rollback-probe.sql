-- The final AUDIT_TEST_PASS exception deliberately rolls back every pg_temp fixture.
DO $probe$
DECLARE src text; u uuid:=gen_random_uuid(); floored uuid:=gen_random_uuid();
 f timestamptz:='2026-09-07 06:00Z'; t timestamptz:='2026-09-14 06:00Z'; j jsonb;
BEGIN
 CREATE TEMP TABLE unions(id uuid) ON COMMIT DROP;
 CREATE TEMP TABLE union_settlement_floor(union_id uuid,earliest_period_start timestamptz) ON COMMIT DROP;
 CREATE TEMP TABLE union_settlement_rounds(union_id uuid,period_start timestamptz,period_end timestamptz,round_no int,round_name text,payers int,payees int,amount numeric,shortfalls int,detail jsonb,UNIQUE(union_id,period_start,period_end,round_no)) ON COMMIT DROP;
 CREATE TEMP TABLE settlement_locks(lock_type text,is_active boolean) ON COMMIT DROP;
 CREATE TEMP TABLE ca_settlements(settlement_type text,union_id uuid,state text,external_ref text,totals jsonb) ON COMMIT DROP;
 CREATE TEMP TABLE union_wallets(union_id uuid,chip_balance numeric,rake_wallet numeric) ON COMMIT DROP;
 CREATE TEMP TABLE clubs(id uuid,name text,chip_treasury numeric) ON COMMIT DROP;
 CREATE TEMP TABLE union_clubs(union_id uuid,club_id uuid) ON COMMIT DROP;
 CREATE TEMP TABLE club_members(user_id uuid,club_id uuid,chip_balance numeric) ON COMMIT DROP;
 CREATE TEMP TABLE probe_values(invoice jsonb,r1 jsonb,r2 jsonb) ON COMMIT DROP;
 INSERT INTO pg_temp.probe_values VALUES('{"success":false,"error":"invoice transport failed"}','{"success":true,"period_rake":100,"total_rakeback":90,"union_retained":10}','{"amount":50,"payees":1,"shortfalls":0}');
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_union_week_start(timestamptz) RETURNS timestamptz LANGUAGE sql AS 'SELECT ''2026-09-14 06:00Z''::timestamptz'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_union_prev_week_start(timestamptz) RETURNS timestamptz LANGUAGE sql AS 'SELECT ''2026-09-07 06:00Z''::timestamptz'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS 'SELECT true'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS 'SELECT false'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_union_settlement_cascade_all(timestamptz,timestamptz) RETURNS jsonb LANGUAGE sql AS 'SELECT ''{"ran":true}''::jsonb'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz) RETURNS jsonb LANGUAGE sql AS 'SELECT r1 FROM pg_temp.probe_values'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_settle_round2_club_to_agents(uuid,timestamptz,timestamptz) RETURNS jsonb LANGUAGE sql AS 'SELECT r2 FROM pg_temp.probe_values'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz) RETURNS jsonb LANGUAGE sql AS 'SELECT ''{"amount":25,"payees":2,"shortfalls":0}''::jsonb'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_union_mark_period_settled(uuid,timestamptz,timestamptz) RETURNS void LANGUAGE sql AS 'SELECT'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_union_eco_enabled(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_union_setting(uuid,text,numeric) RETURNS numeric LANGUAGE sql AS 'SELECT 1::numeric'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_union_issue_weekly_invoices(uuid,timestamptz,timestamptz,boolean) RETURNS jsonb LANGUAGE sql AS 'SELECT invoice FROM pg_temp.probe_values'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_is_union_overseer(uuid,uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_is_platform_admin() RETURNS boolean LANGUAGE sql AS 'SELECT false'$f$;
 SELECT pg_get_functiondef('public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure) INTO src; src:=replace(replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp'''),'now()','''2026-09-14 12:15Z''::timestamptz'); EXECUTE src;
SELECT pg_get_functiondef('public.fn_union_settlement_cascade_due()'::regprocedure) INTO src; src:=replace(replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp'''),'now()','''2026-09-14 12:15Z''::timestamptz'); EXECUTE src;
SELECT pg_get_functiondef('public.fn_union_settlement_conservation_assert(uuid,timestamptz,timestamptz,jsonb,jsonb,jsonb)'::regprocedure) INTO src; src:=replace(replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp'''),'now()','''2026-09-14 12:15Z''::timestamptz'); EXECUTE src;
 INSERT INTO pg_temp.unions VALUES(u),(floored);
 INSERT INTO pg_temp.union_settlement_floor VALUES(floored,t);
 INSERT INTO pg_temp.union_wallets VALUES(u,10,0);
 j:=pg_temp.fn_union_settlement_cascade(u,f,t);
 IF j->>'success'<>'false' THEN RAISE EXCEPTION 'FAIL invoice failure not returned'; END IF;
 INSERT INTO pg_temp.union_settlement_rounds(union_id,period_start,period_end,round_no) VALUES(floored,f,t,1);
 j:=pg_temp.fn_union_settlement_cascade_due();
 IF j->>'ran' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'FAIL unfinished cascade considered done: %',j; END IF;
 UPDATE pg_temp.probe_values SET invoice='{"success":true,"invoices":2}',r2='{"amount":50,"payees":1,"shortfalls":1}';
 j:=pg_temp.fn_union_settlement_cascade(u,f,t);
 j:=pg_temp.fn_union_settlement_cascade_due();
 IF j->>'ran' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'FAIL shortfall considered complete'; END IF;
 UPDATE pg_temp.probe_values SET r2='{"amount":50,"payees":1,"shortfalls":0}';
 j:=pg_temp.fn_union_settlement_cascade(u,f,t);
 j:=pg_temp.fn_union_settlement_cascade_due();
 IF j->>'reason' IS DISTINCT FROM 'already_settled' THEN RAISE EXCEPTION 'FAIL eligible completed union not recognized: %',j; END IF;
 -- The original tolerance accepted a one-cent loss. Exact decimal equality must refuse it.
 BEGIN
  PERFORM pg_temp.fn_union_settlement_conservation_assert(u,f,t,'{"period_rake":100,"total_rakeback":90,"union_retained":9.99}','{"amount":50}','{"amount":25}');
  RAISE EXCEPTION 'FAIL one cent accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'CONSERVATION_BREACH%' THEN RAISE; END IF; END;
 BEGIN
  PERFORM pg_temp.fn_union_settlement_conservation_assert(u,f,t,'{}','{"amount":50}','{"amount":25}');
  RAISE EXCEPTION 'FAIL missing totals accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'CONSERVATION_UNVERIFIED%' THEN RAISE; END IF; END;
 INSERT INTO pg_temp.ca_settlements VALUES('union_rakeback_close',u,'final',u::text||':2026-09-07T06:00:00Z..2026-09-14T06:00:00Z','{"period_rake":100,"payout_total":90,"retained":10}');
 j:=pg_temp.fn_union_settlement_conservation_assert(u,f,t,'{"error":"already_executed"}','{"amount":50}','{"amount":25}');
 IF j->>'checks'<>'7' OR (j->>'round1_paid')::numeric<>90 THEN RAISE EXCEPTION 'FAIL authoritative replay totals'; END IF;
 UPDATE pg_temp.union_wallets SET rake_wallet=NULL;
 BEGIN
  PERFORM pg_temp.fn_union_settlement_conservation_assert(u,f,t,'{"error":"already_executed"}','{"amount":50}','{"amount":25}');
  RAISE EXCEPTION 'FAIL null bank accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'CONSERVATION_BREACH%' THEN RAISE; END IF; END;
 RAISE EXCEPTION 'AUDIT_TEST_PASS: actual cascade/due/assert bodies, invoice failure retry, refreshed invoice result, shortfall retry, eligible-union completion, exact one-cent rejection, missing totals, finalized replay totals and null bank rejection. All pg_temp rolled back. Financial round helpers, permissions, invoices and clock stubbed.';
END;
$probe$;