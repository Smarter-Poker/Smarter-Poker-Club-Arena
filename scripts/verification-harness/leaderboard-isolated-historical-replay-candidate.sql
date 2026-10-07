-- UNQUALIFIED source preparation. Never run against production.
-- Two selections of this same file: psql -v historical_before=true/false.
-- BEFORE: append to the exact authorization fixture with its final ROLLBACK
-- removed, original functions still installed. Commit ONLY this disposable DB.
-- Then install prospective config/opening candidates; AFTER starts its own
-- transaction and rolls back verification. Root destroys the entire owned DB.
-- AFTER requires candidate_opening_body_md5/candidate_publish_body_md5 derived
-- from the exact installed generated candidate definitions, not guessed values.
-- Original first-completion and original replay responses differ by contract;
-- comparison is original replay versus prospective replay, not first response.
\set ON_ERROR_STOP on
\if :historical_before
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
DO $guard$ BEGIN
  IF session_user<>'leaderboard_qualification_bootstrap' OR current_user<>session_user
    OR inet_server_addr() IS NOT NULL OR current_database()<>'postgres'
    OR (SELECT count(*) FROM auth.users)<>5 OR (SELECT count(*) FROM public.clubs)<>3
    OR EXISTS(SELECT 1 FROM public.club_opening_setups)
    OR to_regnamespace('leaderboard_historical_fixture') IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM public.clubs WHERE id='92000000-0000-4000-8000-000000000002'
      AND owner_id='90000000-0000-4000-8000-000000000002' AND chip_treasury=100000 AND promo_balance=0)
    OR md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean)'::regprocedure))
       <>'578960fee3c325b9c724e976bed968f4'
    OR md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_publish_leaderboard_reward_program(uuid,boolean,text,jsonb,jsonb,text,integer,uuid,boolean)'::regprocedure))
       <>'ef4ab9935eb3681ba4f1ab068a8b65fd' THEN
    RAISE EXCEPTION 'Exact original disposable historical fixture required';
  END IF;
END $guard$;
CREATE SCHEMA leaderboard_historical_fixture;
REVOKE ALL ON SCHEMA leaderboard_historical_fixture FROM PUBLIC;
CREATE TABLE leaderboard_historical_fixture.proof(operation uuid PRIMARY KEY,opening_replay jsonb,
  publication_replay jsonb, image text NOT NULL);
CREATE FUNCTION leaderboard_historical_fixture.digest() RETURNS text LANGUAGE plpgsql AS $digest$
DECLARE relation text; rows jsonb; image jsonb:='{}'; BEGIN
  FOREACH relation IN ARRAY ARRAY['clubs','club_members','union_wallets','chip_ledger',
    'ca_mint_ledger','chip_transactions','wallet_transactions','club_wallet_transactions',
    'union_wallet_transactions','wallet_credit_idempotency','club_opening_setups',
    'club_opening_setup_funding','leaderboard_reward_program_versions','club_leaderboard_settings',
    'promotions','bbj_pools','spin_bonus_pools','spin_reserve_ledger','leaderboard_payout_batches'] LOOP
    EXECUTE format('SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.%I t',relation) INTO rows;
    image:=image||jsonb_build_object(relation,rows);
  END LOOP;
  RETURN md5(image::text);
END $digest$;
DO $prepare$
DECLARE club constant uuid:='92000000-0000-4000-8000-000000000002';
  operation uuid:=gen_random_uuid(); opened jsonb; opening_replay jsonb; publication_replay jsonb;
  expected_version integer;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
  PERFORM set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000002',true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  SET LOCAL ROLE authenticated;
  opened:=public.fn_complete_club_opening_setup(club,operation,'Historical Recovery',-1,-1,
    false,0,false,0,1,false,'leaderboard','Historical Promotion','',0,true,'profit',100,true);
  opening_replay:=public.fn_complete_club_opening_setup(club,operation,'Historical Recovery',-1,-1,
    false,0,false,0,1,false,'leaderboard','Historical Promotion','',0,true,'profit',100,true);
  RESET ROLE;
  IF (opened->>'success')::boolean IS DISTINCT FROM true
    OR (opening_replay->>'already_completed')::boolean IS DISTINCT FROM true
    OR (SELECT leaderboard_seed_remaining FROM public.club_opening_setups WHERE club_id=club) IS DISTINCT FROM 100
    OR (SELECT chip_treasury FROM public.clubs WHERE id=club) IS DISTINCT FROM 99900
    OR (SELECT promo_balance FROM public.clubs WHERE id=club) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Original historical funding evidence differs';
  END IF;
  SELECT version-1 INTO STRICT expected_version FROM public.leaderboard_reward_program_versions
    WHERE club_id=club AND operation_id=operation;
  SET LOCAL ROLE authenticated;
  publication_replay:=public.fn_publish_leaderboard_reward_program(club,true,'profit',
    '[{"rank":1,"amount":50},{"rank":2,"amount":30},{"rank":3,"amount":20}]','[]','balanced',
    expected_version,operation,true);
  RESET ROLE;
  SET CONSTRAINTS ALL IMMEDIATE;
  INSERT INTO leaderboard_historical_fixture.proof VALUES(operation,opening_replay,publication_replay,
    leaderboard_historical_fixture.digest());
END $prepare$;
COMMIT;
\else
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
SELECT set_config('leaderboard_test.opening_body_md5', :'candidate_opening_body_md5', true);
SELECT set_config('leaderboard_test.publish_body_md5', :'candidate_publish_body_md5', true);
DO $verify$
DECLARE club constant uuid:='92000000-0000-4000-8000-000000000002';
  proof leaderboard_historical_fixture.proof%ROWTYPE; opening_replay jsonb; publication_replay jsonb;
  expected_version integer; rejected boolean:=false;
BEGIN
  IF session_user<>'leaderboard_qualification_bootstrap' OR current_user<>session_user
    OR inet_server_addr() IS NOT NULL OR current_database()<>'postgres'
    OR (SELECT count(*) FROM auth.users)<>5 OR (SELECT count(*) FROM public.clubs)<>3
    OR (SELECT count(*) FROM leaderboard_historical_fixture.proof)<>1
    OR current_setting('leaderboard_test.opening_body_md5') !~ '^[0-9a-f]{32}$'
    OR current_setting('leaderboard_test.publish_body_md5') !~ '^[0-9a-f]{32}$'
    OR current_setting('leaderboard_test.opening_body_md5')='578960fee3c325b9c724e976bed968f4'
    OR current_setting('leaderboard_test.publish_body_md5')='ef4ab9935eb3681ba4f1ab068a8b65fd'
    OR md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean)'::regprocedure))
       <>current_setting('leaderboard_test.opening_body_md5')
    OR md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_publish_leaderboard_reward_program(uuid,boolean,text,jsonb,jsonb,text,integer,uuid,boolean)'::regprocedure))
       <>current_setting('leaderboard_test.publish_body_md5') THEN
    RAISE EXCEPTION 'Exact disposable historical readback required';
  END IF;
  SELECT * INTO STRICT proof FROM leaderboard_historical_fixture.proof;
  IF leaderboard_historical_fixture.digest() IS DISTINCT FROM proof.image THEN
    RAISE EXCEPTION 'Candidate installation changed historical state';
  END IF;
  SELECT version-1 INTO STRICT expected_version FROM public.leaderboard_reward_program_versions
    WHERE club_id=club AND operation_id=proof.operation;
  PERFORM set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
  PERFORM set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000002',true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  SET LOCAL ROLE authenticated;
  opening_replay:=public.fn_complete_club_opening_setup(club,proof.operation,'Historical Recovery',-1,-1,
    false,0,false,0,1,false,'leaderboard','Historical Promotion','',0,true,'profit',100,true);
  publication_replay:=public.fn_publish_leaderboard_reward_program(club,true,'profit',
    '[{"rank":1,"amount":50},{"rank":2,"amount":30},{"rank":3,"amount":20}]','[]','balanced',
    expected_version,proof.operation,true);
  BEGIN
    PERFORM public.fn_publish_leaderboard_reward_program(club,true,'profit',
      '[{"rank":1,"amount":50},{"rank":2,"amount":30},{"rank":3,"amount":20}]','[]','balanced',
      expected_version+1,gen_random_uuid(),true);
  EXCEPTION WHEN SQLSTATE '22023' THEN
    IF SQLERRM<>'LEADERBOARD_PROMO_ONLY|Club Bank Overlay Is Not Allowed For Leaderboard Prizes' THEN RAISE; END IF;
    rejected:=true;
  END;
  RESET ROLE;
  SET CONSTRAINTS ALL IMMEDIATE;
  IF NOT rejected OR opening_replay IS DISTINCT FROM proof.opening_replay
    OR publication_replay IS DISTINCT FROM proof.publication_replay
    OR leaderboard_historical_fixture.digest() IS DISTINCT FROM proof.image THEN
    RAISE EXCEPTION 'Historical replay or atomic new-overlay refusal differs';
  END IF;
END $verify$;
SELECT 'HISTORICAL_REPLAY|PASS';
ROLLBACK;
\endif
