\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN: isolated full PostgreSQL17 catalog, never production.
BEGIN;
SET LOCAL statement_timeout='60s';SET LOCAL lock_timeout='3s';SET LOCAL TimeZone='UTC';SET LOCAL DateStyle='ISO,YMD';
DO $guard$ BEGIN
 IF session_user<>'postgres' OR current_user<>'postgres' OR inet_server_addr() IS NOT NULL
  OR to_regprocedure('public.fn_accounting_run_observation_v1(uuid,text,uuid,timestamptz,timestamptz)') IS NULL
 THEN RAISE EXCEPTION 'isolated complete browser observer fixture required';END IF;
END$guard$;
CREATE FUNCTION pg_temp.observer_check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'observer fixture failed: %',label;END IF;
 RAISE NOTICE 'observer fixture passed: %',label;END$$;
CREATE FUNCTION pg_temp.observer_id(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('e6490000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
CREATE FUNCTION pg_temp.observer_actor(who uuid,role_name text DEFAULT 'authenticated') RETURNS void LANGUAGE plpgsql AS $$BEGIN
 PERFORM set_config('request.jwt.claim.sub',COALESCE(who::text,''),true);PERFORM set_config('request.jwt.claim.role',role_name,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role',role_name,'sub',who)::text,true);END$$;
CREATE FUNCTION pg_temp.observer_state() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE n text;j jsonb;answer jsonb:='{}';BEGIN
 FOREACH n IN ARRAY ARRAY['settlement_periods','union_accounting_runs','clubs','unions','club_members','agents','union_wallets',
  'chip_ledger','chip_ledger_idem','chip_transactions','wallet_transactions','club_wallet_transactions','union_wallet_transactions',
  'cashout_requests','chip_escrow','rakeback_periods','settlement_invoices','accounting_invoice_deliveries','accounting_conversations',
  'social_messages','social_conversations','social_conversation_participants','notifications','push_outbox','financial_alerts',
  'ca_drift_incidents','ca_incident_events','accounting_cashier_events','accounting_correction_documents','ca_mint_ledger'] LOOP
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM public.%I t',n) INTO j;
  answer:=answer||jsonb_build_object(n,j);
 END LOOP;RETURN answer;
END$$;
CREATE FUNCTION pg_temp.observer_shape(j jsonb,wanted_state text,wanted_found boolean) RETURNS void LANGUAGE plpgsql AS $$DECLARE keys text[];BEGIN
 SELECT array_agg(key ORDER BY key) INTO keys FROM jsonb_object_keys(j)key;
 PERFORM pg_temp.observer_check(keys=ARRAY['actor_user_id','attempts','contract_version','expected_run_at','finished_at','observed_at','period_end','period_start','posted','record_found','recorded_scheduled_at','scope_id','scope_kind','started_at','state']
  AND j->'contract_version'='1'::jsonb AND j->>'state'=wanted_state AND j->'record_found'=to_jsonb(wanted_found)
  AND j->'posted'=to_jsonb(wanted_state='posted'),'exact status-only envelope '||wanted_state);
 IF wanted_state IN('unavailable','no_recorded_run') THEN
  PERFORM pg_temp.observer_check(j->'recorded_scheduled_at'='null'::jsonb AND j->'attempts'='null'::jsonb
   AND j->'started_at'='null'::jsonb AND j->'finished_at'='null'::jsonb,'unconfirmed/no-record fields are explicit null');
 END IF;
END$$;
DO $temp$ DECLARE n name;BEGIN SELECT nspname INTO STRICT n FROM pg_namespace WHERE oid=pg_my_temp_schema();
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO authenticated,service_role',n);END$temp$;
REVOKE ALL ON FUNCTION pg_temp.observer_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_temp.observer_check(boolean,text),pg_temp.observer_id(integer),pg_temp.observer_actor(uuid,text),pg_temp.observer_state(),pg_temp.observer_shape(jsonb,text,boolean) TO authenticated,service_role;
CREATE TEMP TABLE observer_results(label text PRIMARY KEY,value jsonb);GRANT SELECT,INSERT,UPDATE ON observer_results TO authenticated,service_role;
CREATE ROLE accounting_observer_fixture_login LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
GRANT authenticated TO accounting_observer_fixture_login;

-- Synthetic baseline only. Existing financial/canonical writers are never
-- used to manufacture the observer's test rows or called by the observer.
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) SELECT pg_temp.observer_id(n) FROM generate_series(1,8)n;
INSERT INTO public.users(id,username) SELECT pg_temp.observer_id(n),'observer_fixture_'||n FROM generate_series(1,8)n;
INSERT INTO public.profiles(id,username,display_name) SELECT pg_temp.observer_id(n),'observer_fixture_'||n,'Observer Fixture '||n FROM generate_series(1,8)n;
INSERT INTO public.clubs(id,club_id,name,owner_id,chip_treasury,is_union,asset) VALUES
 (pg_temp.observer_id(101),964901,'Observer Club',pg_temp.observer_id(1),1000,false,'chips'),
 (pg_temp.observer_id(102),964902,'Other Observer Club',pg_temp.observer_id(6),1000,false,'chips');
INSERT INTO public.club_members(club_id,user_id,role,status,is_active,membership_lifecycle_status,chip_balance)
 SELECT pg_temp.observer_id(101),pg_temp.observer_id(n),CASE n WHEN 1 THEN 'owner' WHEN 3 THEN 'co_owner' WHEN 4 THEN 'admin' ELSE 'player' END,
 'active',true,'active',100 FROM generate_series(1,5)n;
SET LOCAL session_replication_role=origin;
-- The no-arg legacy getter refuses in an exact zero-union baseline too.
CREATE TEMP TABLE observer_saved_unions AS SELECT * FROM public.unions;
DO $zero_union$ DECLARE before_state jsonb;BEGIN
 PERFORM set_config('session_replication_role','replica',true);DELETE FROM public.unions;PERFORM set_config('session_replication_role','origin',true);
 before_state:=pg_temp.observer_state();
 BEGIN PERFORM public.get_current_settlement_period();RAISE EXCEPTION 'zero-union getter accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'automatic_weekly_accounting_only' THEN RAISE;END IF;END;
 PERFORM pg_temp.observer_check(pg_temp.observer_state()=before_state,'zero-union legacy getter cannot mutate');
 PERFORM set_config('session_replication_role','replica',true);INSERT INTO public.unions SELECT * FROM observer_saved_unions;PERFORM set_config('session_replication_role','origin',true);
END$zero_union$;
SET LOCAL session_replication_role=replica;
INSERT INTO public.unions(id,name,owner_id,slug,chip_balance,rake_wallet,bbj_wallet,promo_wallet)
 VALUES(pg_temp.observer_id(110),'Observer Union',pg_temp.observer_id(6),'observer-union-fixture',1000,0,0,0);
UPDATE public.clubs SET union_id=pg_temp.observer_id(110) WHERE id=pg_temp.observer_id(101);
SET LOCAL session_replication_role=origin;
-- Exact one/many union counts are constructed under replica and restored; no
-- create-on-read function is ever run from its pre-retirement definition.
CREATE FUNCTION pg_temp.observer_retired_calls() RETURNS void LANGUAGE plpgsql AS $$DECLARE before_state jsonb;statement text;BEGIN
 FOREACH statement IN ARRAY ARRAY[
  'SELECT public.fn_open_settlement_period(''e6490000-0000-4000-8000-000000000101''::uuid)',
  'SELECT public.fn_set_settlement_period_status(''e6490000-0000-4000-8000-000000000301''::uuid,''settled'')',
  'SELECT public.get_current_settlement_period()',
  'SELECT public.get_current_settlement_period(''e6490000-0000-4000-8000-000000000101''::uuid)'] LOOP
  before_state:=pg_temp.observer_state();
  BEGIN EXECUTE statement;RAISE EXCEPTION 'legacy period authority accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'automatic_weekly_accounting_only' THEN RAISE;END IF;END;
  PERFORM pg_temp.observer_check(pg_temp.observer_state()=before_state,'retired signature preserves all authoritative rows: '||statement);
 END LOOP;
END$$;
GRANT EXECUTE ON FUNCTION pg_temp.observer_retired_calls() TO authenticated,service_role;
SELECT pg_temp.observer_actor(pg_temp.observer_id(1));SELECT pg_temp.observer_retired_calls();
SET LOCAL ROLE authenticated;SELECT pg_temp.observer_retired_calls();RESET ROLE;
SELECT pg_temp.observer_actor(NULL,'service_role');SET LOCAL ROLE service_role;SELECT pg_temp.observer_retired_calls();RESET ROLE;
DO $one_union$ DECLARE before_state jsonb;BEGIN
 PERFORM set_config('session_replication_role','replica',true);DELETE FROM public.unions WHERE id<>pg_temp.observer_id(110);PERFORM set_config('session_replication_role','origin',true);
 before_state:=pg_temp.observer_state();PERFORM pg_temp.observer_check((SELECT count(*)=1 FROM public.unions),'exact one-union baseline');
 PERFORM pg_temp.observer_retired_calls();PERFORM pg_temp.observer_check(pg_temp.observer_state()=before_state,'one-union getter cannot create a period');
 PERFORM set_config('session_replication_role','replica',true);INSERT INTO public.unions SELECT * FROM observer_saved_unions;PERFORM set_config('session_replication_role','origin',true);
END$one_union$;
SET LOCAL session_replication_role=replica;
INSERT INTO public.unions(id,name,owner_id,slug,chip_balance,rake_wallet,bbj_wallet,promo_wallet)
 VALUES(pg_temp.observer_id(111),'Other Observer Union',pg_temp.observer_id(7),'other-observer-union-fixture',1000,0,0,0);
INSERT INTO public.settlement_periods(id,club_id,union_id,period_number,year,start_at,end_at,status,settled_at)
 VALUES(pg_temp.observer_id(301),NULL,pg_temp.observer_id(110),37,2026,'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z','settled','2026-09-14T09:01:00Z'),
 (pg_temp.observer_id(302),pg_temp.observer_id(101),NULL,37,2026,'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z','closed','2026-09-14T09:01:00Z');
INSERT INTO public.union_accounting_runs(union_id,standalone_club_id,period_start,period_end,scheduled_at,status,attempts,started_at,finished_at,result)
 VALUES(pg_temp.observer_id(110),NULL,'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z','2026-09-14T09:00:00Z','complete',2,'2026-09-14T09:00:00.123456Z','2026-09-14T09:01:00.654321Z',
 jsonb_build_object('success',true,'accounting_version',3,'union_id',pg_temp.observer_id(110),'period_start','2026-09-07T00:00:00-07:00','period_end','2026-09-14T00:00:00-07:00','PRIVATE_FAILURE_CONTEXT','must never leave reader','total_paid',987654321)),
 (NULL,pg_temp.observer_id(101),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z','2026-09-14T09:00:00Z','complete',1,'2026-09-14T09:00:00.234567Z','2026-09-14T09:01:00.765432Z',
 jsonb_build_object('success',true,'accounting_version',3,'scope_kind','club','scope_id',pg_temp.observer_id(101),'period_start','2026-09-07T07:00:00Z','period_end','2026-09-14T07:00:00Z','payee_ids',ARRAY[pg_temp.observer_id(2)]));
SET LOCAL session_replication_role=origin;
SELECT pg_temp.observer_retired_calls();
CREATE TEMP TABLE observer_before AS SELECT pg_temp.observer_state() AS state;GRANT SELECT ON observer_before TO authenticated,service_role;

-- Unlike SET ROLE alone, this also makes session_user non-owner. It tests the
-- database identity gates; a separate provider/JWT connection remains required.
SET SESSION AUTHORIZATION accounting_observer_fixture_login;
SET ROLE authenticated;
SELECT pg_temp.observer_check(session_user='accounting_observer_fixture_login' AND current_user='authenticated','actual non-owner session identity for scope tests');
SELECT pg_temp.observer_actor(pg_temp.observer_id(6));
INSERT INTO observer_results VALUES('union_posted',public.fn_accounting_run_observation_v1(auth.uid(),'union',pg_temp.observer_id(110),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z'));
SELECT pg_temp.observer_shape(value,'posted',true) FROM observer_results WHERE label='union_posted';
SELECT pg_temp.observer_check((SELECT value->>'started_at'='2026-09-14T09:00:00.123456+00:00' AND value->>'finished_at'='2026-09-14T09:01:00.654321+00:00' FROM observer_results WHERE label='union_posted'),'native UTC transport preserves microseconds');
INSERT INTO observer_results VALUES('union_none',public.fn_accounting_run_observation_v1(auth.uid(),'union',pg_temp.observer_id(110),'2026-08-31T07:00:00Z','2026-09-07T07:00:00Z'));
SELECT pg_temp.observer_shape(value,'no_recorded_run',false) FROM observer_results WHERE label='union_none';
DO $authority$ DECLARE before_state jsonb;BEGIN
 before_state:=pg_temp.observer_state();
 BEGIN PERFORM public.fn_accounting_run_observation_v1(pg_temp.observer_id(1),'union',pg_temp.observer_id(110),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z');RAISE EXCEPTION 'wrong actor accepted';
 EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'accounting_observation_account_changed' THEN RAISE;END IF;END;
 BEGIN PERFORM public.fn_accounting_run_observation_v1(auth.uid(),'union',pg_temp.observer_id(111),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z');RAISE EXCEPTION 'other union accepted';
 EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'accounting_observation_not_authorized' THEN RAISE;END IF;END;
 PERFORM pg_temp.observer_check(pg_temp.observer_state()=before_state,'account and unrelated union refusals write nothing');
END$authority$;
SELECT pg_temp.observer_actor(pg_temp.observer_id(1));
INSERT INTO observer_results VALUES('club_posted',public.fn_accounting_run_observation_v1(auth.uid(),'club',pg_temp.observer_id(101),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z'));
SELECT pg_temp.observer_shape(value,'posted',true) FROM observer_results WHERE label='club_posted';
INSERT INTO observer_results VALUES('club_absent',public.fn_accounting_run_observation_v1(auth.uid(),'club',pg_temp.observer_id(101),'2026-08-31T07:00:00Z','2026-09-07T07:00:00Z'));
SELECT pg_temp.observer_shape(value,'unavailable',false) FROM observer_results WHERE label='club_absent';
DO $club_not_union$ BEGIN
 BEGIN PERFORM public.fn_accounting_run_observation_v1(auth.uid(),'union',pg_temp.observer_id(110),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z');RAISE EXCEPTION 'club owner gained union observation';
 EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'accounting_observation_not_authorized' THEN RAISE;END IF;END;
END$club_not_union$;
DO $staff$ DECLARE n integer;j jsonb;before_state jsonb;BEGIN
 FOREACH n IN ARRAY ARRAY[3,4] LOOP
  PERFORM pg_temp.observer_actor(pg_temp.observer_id(n));before_state:=pg_temp.observer_state();
  j:=public.fn_accounting_run_observation_v1(auth.uid(),'club',pg_temp.observer_id(101),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z');
  PERFORM pg_temp.observer_shape(j,'posted',true);
  PERFORM pg_temp.observer_check(j->>'actor_user_id'=pg_temp.observer_id(n)::text AND pg_temp.observer_state()=before_state,'current co-owner/admin scoped observation preserves actual rows');
 END LOOP;
END$staff$;
SELECT pg_temp.observer_actor(pg_temp.observer_id(2));
DO $member$ DECLARE kind text;scope uuid;BEGIN
 FOREACH kind IN ARRAY ARRAY['club','union'] LOOP scope:=CASE kind WHEN 'club' THEN pg_temp.observer_id(101) ELSE pg_temp.observer_id(110) END;
 BEGIN PERFORM public.fn_accounting_run_observation_v1(auth.uid(),kind,scope,'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z');RAISE EXCEPTION 'general member gained accounting observer';
 EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'accounting_observation_not_authorized' THEN RAISE;END IF;END;
 END LOOP;PERFORM pg_temp.observer_retired_calls();
END$member$;
SELECT pg_temp.observer_check(pg_temp.observer_state()=(SELECT state FROM observer_before),'all actual non-owner observer/retirement calls preserve authoritative rows');
RESET ROLE;RESET SESSION AUTHORIZATION;

-- Each response/refusal below is compared with the complete authoritative row
-- snapshot after intentional fixture setup; setup is not called observation.
SELECT pg_temp.observer_actor(pg_temp.observer_id(6));
SET LOCAL ROLE authenticated;
DO $inputs$ DECLARE before_state jsonb;statement text;expected_error text;expected_state text;BEGIN
 FOR statement,expected_state,expected_error IN SELECT * FROM (VALUES
  ('SELECT public.fn_accounting_run_observation_v1(NULL,''union'',''e6490000-0000-4000-8000-000000000110'',''2026-09-07T07:00:00Z'',''2026-09-14T07:00:00Z'')','42501','accounting_observation_account_changed'),
  ('SELECT public.fn_accounting_run_observation_v1(''00000000-0000-0000-0000-000000000000'',''union'',''e6490000-0000-4000-8000-000000000110'',''2026-09-07T07:00:00Z'',''2026-09-14T07:00:00Z'')','42501','accounting_observation_account_changed'),
  ('SELECT public.fn_accounting_run_observation_v1(auth.uid(),''union'',''00000000-0000-0000-0000-000000000000'',''2026-09-07T07:00:00Z'',''2026-09-14T07:00:00Z'')','22023','invalid_accounting_observation_scope'),
  ('SELECT public.fn_accounting_run_observation_v1(auth.uid(),''global'',NULL,''2026-09-07T07:00:00Z'',''2026-09-14T07:00:00Z'')','22023','invalid_accounting_observation_scope'),
  ('SELECT public.fn_accounting_run_observation_v1(auth.uid(),''union'',''e6490000-0000-4000-8000-000000000110'',NULL,''2026-09-14T07:00:00Z'')','22023','invalid_accounting_observation_week'),
  ('SELECT public.fn_accounting_run_observation_v1(auth.uid(),''union'',''e6490000-0000-4000-8000-000000000110'',''-infinity'',''infinity'')','22023','invalid_accounting_observation_week'),
  ('SELECT public.fn_accounting_run_observation_v1(auth.uid(),''union'',''e6490000-0000-4000-8000-000000000110'',''2026-09-07T07:00:00.000001Z'',''2026-09-14T07:00:00Z'')','22023','invalid_accounting_observation_week'),
  ('SELECT public.fn_accounting_run_observation_v1(auth.uid(),''union'',''e6490000-0000-4000-8000-000000000110'',''2026-03-02T08:00:00Z'',''2026-03-09T08:00:00Z'')','22023','invalid_accounting_observation_week')
 )v(statement,wanted_state,wanted_error) LOOP
  before_state:=pg_temp.observer_state();
  BEGIN EXECUTE statement;RAISE EXCEPTION 'invalid observation input accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLSTATE IS DISTINCT FROM expected_state OR SQLERRM IS DISTINCT FROM expected_error THEN RAISE;END IF;END;
  PERFORM pg_temp.observer_check(pg_temp.observer_state()=before_state,'exact invalid input refusal changes no authoritative rows: '||expected_error);
 END LOOP;
 PERFORM pg_temp.observer_actor('00000000-0000-0000-0000-000000000000');
 BEGIN PERFORM public.fn_accounting_run_observation_v1(auth.uid(),'union',pg_temp.observer_id(110),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z');RAISE EXCEPTION 'zero actual actor accepted';
 EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'accounting_observation_account_changed' THEN RAISE;END IF;END;
END$inputs$;
SELECT pg_temp.observer_actor(pg_temp.observer_id(6));
DO $dst$ DECLARE j jsonb;first jsonb;second jsonb;before_state jsonb;BEGIN
 before_state:=pg_temp.observer_state();
 j:=public.fn_accounting_run_observation_v1(auth.uid(),'union',pg_temp.observer_id(110),'2026-03-02T08:00:00Z','2026-03-09T07:00:00Z');
 PERFORM pg_temp.observer_shape(j,'no_recorded_run',false);
 PERFORM pg_temp.observer_check(j->>'period_start'='2026-03-02T08:00:00+00:00' AND j->>'period_end'='2026-03-09T07:00:00+00:00'
  AND j->>'expected_run_at'='2026-03-09T09:00:00+00:00','Pacific 167-hour week and Chicago daylight schedule');
 j:=public.fn_accounting_run_observation_v1(auth.uid(),'union',pg_temp.observer_id(110),'2025-10-27T07:00:00Z','2025-11-03T08:00:00Z');
 PERFORM pg_temp.observer_shape(j,'no_recorded_run',false);
 PERFORM pg_temp.observer_check(j->>'period_start'='2025-10-27T07:00:00+00:00' AND j->>'period_end'='2025-11-03T08:00:00+00:00'
  AND j->>'expected_run_at'='2025-11-03T10:00:00+00:00','Pacific 169-hour week and Chicago standard schedule');
 first:=public.fn_accounting_run_observation_v1(auth.uid(),'union',pg_temp.observer_id(110),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z');
 PERFORM set_config('TimeZone','America/Chicago',true);PERFORM set_config('DateStyle','SQL,DMY',true);
 second:=public.fn_accounting_run_observation_v1(auth.uid(),'union',pg_temp.observer_id(110),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z');
 PERFORM pg_temp.observer_check(first=second,'same statement observer is byte-identical across session timezone and DateStyle including microseconds');
 PERFORM set_config('TimeZone','UTC',true);PERFORM set_config('DateStyle','ISO,YMD',true);
 PERFORM pg_temp.observer_check(pg_temp.observer_state()=before_state,'DST and formatting reads change no authoritative rows');
END$dst$;
RESET ROLE;
SELECT pg_temp.observer_actor(NULL,'service_role');SET LOCAL ROLE service_role;
DO $null_service$ DECLARE before_state jsonb;BEGIN before_state:=pg_temp.observer_state();
 BEGIN PERFORM public.fn_accounting_run_observation_v1(pg_temp.observer_id(6),'union',pg_temp.observer_id(110),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z');RAISE EXCEPTION 'service impersonation accepted';
 EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'accounting_observation_account_changed' THEN RAISE;END IF;END;
 PERFORM pg_temp.observer_check(pg_temp.observer_state()=before_state,'service without actual actor cannot observe or impersonate');END$null_service$;
RESET ROLE;

CREATE TEMP TABLE observer_saved_run AS SELECT * FROM public.union_accounting_runs WHERE union_id=pg_temp.observer_id(110);
DO $malformed$ DECLARE test_case record;baseline public.union_accounting_runs%ROWTYPE;before_state jsonb;j jsonb;BEGIN
 SELECT * INTO STRICT baseline FROM observer_saved_run;
 FOR test_case IN SELECT * FROM (VALUES
  ('legacy version','{"accounting_version":2}'::jsonb,'complete',NULL::text,'unavailable'),
  ('string version','{"accounting_version":"3"}'::jsonb,'complete',NULL::text,'unavailable'),
  ('string success','{"success":"true"}'::jsonb,'complete',NULL::text,'unavailable'),
  ('false success','{"success":false}'::jsonb,'complete',NULL::text,'unavailable'),
  ('missing version','{"accounting_version":null}'::jsonb,'complete',NULL::text,'unavailable'),
  ('wrong scope','{"union_id":"e6490000-0000-4000-8000-000000000111"}'::jsonb,'complete',NULL::text,'unavailable'),
  ('wrong week','{"period_end":"2026-09-21T07:00:00Z"}'::jsonb,'complete',NULL::text,'unavailable'),
  ('non ISO date','{"period_start":"09/07/2026 07:00:00"}'::jsonb,'complete',NULL::text,'unavailable'),
  ('invalid ISO date','{"period_start":"2026-99-07T07:00:00Z"}'::jsonb,'complete',NULL::text,'unavailable'),
  ('infinite source date','{"period_start":"infinity"}'::jsonb,'complete',NULL::text,'unavailable'),
  ('too precise date','{"period_start":"2026-09-07T07:00:00.0000000Z"}'::jsonb,'complete',NULL::text,'unavailable'),
  ('object date','{"period_start":{}}'::jsonb,'complete',NULL::text,'unavailable'),
  ('bad scheduled','{}'::jsonb,'complete','scheduled','unavailable'),
  ('infinite started','{}'::jsonb,'complete','infinite_started','unavailable'),
  ('infinite finished','{}'::jsonb,'complete','infinite_finished','unavailable'),
  ('reversed dates','{}'::jsonb,'complete','reversed','unavailable'),
  ('future started','{}'::jsonb,'complete','future','unavailable'),
  ('zero attempts','{}'::jsonb,'complete','zero_attempts','unavailable'),
  ('no finished','{}'::jsonb,'complete','no_finished','unavailable'),
  ('failed exact','{"success":false,"error":"PRIVATE_FAILURE_CONTEXT"}'::jsonb,'failed',NULL::text,'incomplete'),
  ('failed string','{"success":"false"}'::jsonb,'failed',NULL::text,'unavailable'),
  ('running exact','{}'::jsonb,'running','no_finished','running'),
  ('running with finish','{}'::jsonb,'running',NULL::text,'unavailable'),
  ('nonobject result','[]'::jsonb,'complete','array_result','unavailable')
 )v(label,result_patch,new_status,variation,wanted_state) LOOP
  UPDATE public.union_accounting_runs SET result=CASE WHEN test_case.variation='array_result' THEN '[]'::jsonb ELSE baseline.result||test_case.result_patch END,
   status=test_case.new_status,attempts=CASE WHEN test_case.variation='zero_attempts' THEN 0 ELSE baseline.attempts END,
   scheduled_at=CASE WHEN test_case.variation='scheduled' THEN baseline.scheduled_at+interval '1 hour' ELSE baseline.scheduled_at END,
   started_at=CASE test_case.variation WHEN 'infinite_started' THEN 'infinity'::timestamptz WHEN 'future' THEN statement_timestamp()+interval '1 day' ELSE baseline.started_at END,
   finished_at=CASE test_case.variation WHEN 'infinite_finished' THEN 'infinity'::timestamptz WHEN 'reversed' THEN baseline.started_at-interval '1 second' WHEN 'no_finished' THEN NULL ELSE baseline.finished_at END
   WHERE union_id=baseline.union_id AND period_start=baseline.period_start AND period_end=baseline.period_end;
  before_state:=pg_temp.observer_state();PERFORM pg_temp.observer_actor(pg_temp.observer_id(6));EXECUTE 'SET LOCAL ROLE authenticated';
  j:=public.fn_accounting_run_observation_v1(auth.uid(),'union',pg_temp.observer_id(110),baseline.period_start,baseline.period_end);
  PERFORM pg_temp.observer_shape(j,test_case.wanted_state,true);
  PERFORM pg_temp.observer_check(position('PRIVATE_FAILURE_CONTEXT' IN j::text)=0 AND position('total_paid' IN j::text)=0,'no diagnostics or amounts for '||test_case.label);
  PERFORM pg_temp.observer_check(pg_temp.observer_state()=before_state,'observer writes nothing for '||test_case.label);
  EXECUTE 'RESET ROLE';
 END LOOP;
 UPDATE public.union_accounting_runs SET result=baseline.result,status=baseline.status,attempts=baseline.attempts,scheduled_at=baseline.scheduled_at,
  started_at=baseline.started_at,finished_at=baseline.finished_at WHERE union_id=baseline.union_id AND period_start=baseline.period_start AND period_end=baseline.period_end;
END$malformed$;

-- Native exact-period consistency: a complete-looking journal alone cannot
-- establish posted. Replica is restricted to synthetic state setup/restoration.
CREATE TEMP TABLE observer_saved_period AS SELECT * FROM public.settlement_periods WHERE id=pg_temp.observer_id(301);
DO $period_consistency$ DECLARE before_state jsonb;j jsonb;state text;BEGIN
 FOREACH state IN ARRAY ARRAY['open','missing'] LOOP
  PERFORM set_config('session_replication_role','replica',true);
  IF state='open' THEN UPDATE public.settlement_periods SET status='open' WHERE id=pg_temp.observer_id(301);
  ELSE DELETE FROM public.settlement_periods WHERE id=pg_temp.observer_id(301);END IF;
  PERFORM set_config('session_replication_role','origin',true);before_state:=pg_temp.observer_state();
  PERFORM pg_temp.observer_actor(pg_temp.observer_id(6));EXECUTE 'SET LOCAL ROLE authenticated';
  j:=public.fn_accounting_run_observation_v1(auth.uid(),'union',pg_temp.observer_id(110),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z');
  PERFORM pg_temp.observer_shape(j,'unavailable',true);PERFORM pg_temp.observer_check(pg_temp.observer_state()=before_state,'complete journal with '||state||' period remains unconfirmed without writes');
  EXECUTE 'RESET ROLE';PERFORM set_config('session_replication_role','replica',true);
  DELETE FROM public.settlement_periods WHERE id=pg_temp.observer_id(301);INSERT INTO public.settlement_periods SELECT * FROM observer_saved_period;
  PERFORM set_config('session_replication_role','origin',true);
 END LOOP;
END$period_consistency$;

-- A private period writer is still private and works under its existing engine
-- context. This checks period ownership only; no coordinator/payment is invoked.
SELECT pg_temp.observer_actor(NULL,'service_role');
DO $canonical_period$ DECLARE before_state jsonb;after_state jsonb;BEGIN
 before_state:=pg_temp.observer_state();
 PERFORM public.fn_mark_scope_accounting_settled('club',pg_temp.observer_id(102),'2026-08-31T07:00:00Z','2026-09-07T07:00:00Z');
 after_state:=pg_temp.observer_state();
 PERFORM pg_temp.observer_check(before_state-'settlement_periods'=after_state-'settlement_periods','canonical period writer changes no money, journals, documents or notices');
 PERFORM pg_temp.observer_check((SELECT count(*)=1 AND bool_and(status='settled') FROM public.settlement_periods WHERE club_id=pg_temp.observer_id(102) AND union_id IS NULL AND start_at='2026-08-31T07:00:00Z' AND end_at='2026-09-07T07:00:00Z'),'canonical writer retains exact standalone period creation');
 before_state:=pg_temp.observer_state();PERFORM public.fn_mark_scope_accounting_settled('club',pg_temp.observer_id(102),'2026-08-31T07:00:00Z','2026-09-07T07:00:00Z');
 PERFORM pg_temp.observer_check(before_state=pg_temp.observer_state(),'canonical settled period replay unchanged');
 PERFORM pg_temp.observer_retired_calls();
END$canonical_period$;

DO $acl$ DECLARE who text;col text;sig text;BEGIN
 FOREACH who IN ARRAY ARRAY['anon','authenticated'] LOOP
  PERFORM pg_temp.observer_check(NOT has_table_privilege(who,'public.settlement_periods','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN'),'no browser period table writes or structural privileges: '||who);
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid='public.settlement_periods'::regclass AND attnum>0 AND NOT attisdropped LOOP
   PERFORM pg_temp.observer_check(NOT has_column_privilege(who,'public.settlement_periods',col,'INSERT,UPDATE,REFERENCES'),'no browser period column authority: '||who||'.'||col);
  END LOOP;
 END LOOP;
 FOREACH sig IN ARRAY ARRAY['public.fn_open_settlement_period(uuid)','public.fn_set_settlement_period_status(uuid,text)','public.get_current_settlement_period()','public.get_current_settlement_period(uuid)','public.fn_accounting_run_observation_v1(uuid,text,uuid,timestamptz,timestamptz)'] LOOP
  PERFORM pg_temp.observer_check(NOT has_function_privilege('anon',sig,'EXECUTE') AND has_function_privilege('authenticated',sig,'EXECUTE') AND has_function_privilege('service_role',sig,'EXECUTE'),'exact stale-refusal/observer grants: '||sig);
 END LOOP;
 PERFORM pg_temp.observer_check(NOT has_function_privilege('authenticated','public.fn_mark_scope_accounting_settled(text,uuid,timestamptz,timestamptz)','EXECUTE') AND NOT has_function_privilege('service_role','public.fn_mark_scope_accounting_settled(text,uuid,timestamptz,timestamptz)','EXECUTE'),'canonical period writer remains private');
 PERFORM pg_temp.observer_check((SELECT count(*)=3 AND bool_and(status='closed') FROM public.ca_money_rpc_registry WHERE proname IN('fn_open_settlement_period','fn_set_settlement_period_status','get_current_settlement_period')),'legacy registry has exactly three closed names covering four signatures');
END$acl$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
