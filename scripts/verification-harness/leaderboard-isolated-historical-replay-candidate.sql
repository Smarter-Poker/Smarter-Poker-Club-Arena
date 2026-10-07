-- UNQUALIFIED source preparation. Never run against production.
-- Two selections of this same file: psql -v historical_before=true/false.
-- BEFORE: append to the exact authorization fixture with its final ROLLBACK
-- removed, original functions still installed. Commit ONLY this disposable DB.
-- Then install prospective capture/ranking/payout/config/opening candidates; AFTER starts its own
-- transaction and rolls back verification. Root destroys the entire owned DB.
-- AFTER requires candidate_opening_body_md5/candidate_publish_body_md5/candidate_payout_body_md5 derived
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
  publication_replay jsonb, payout_replay jsonb, period_start date, period_end date, image text NOT NULL);
CREATE FUNCTION leaderboard_historical_fixture.digest() RETURNS text LANGUAGE plpgsql AS $digest$
DECLARE relation text; rows jsonb; image jsonb:='{}'; BEGIN
  FOREACH relation IN ARRAY ARRAY['clubs','club_members','union_wallets','chip_ledger',
    'ca_mint_ledger','chip_transactions','wallet_transactions','club_wallet_transactions',
    'union_wallet_transactions','wallet_credit_idempotency','club_opening_setups',
    'club_opening_setup_funding','leaderboard_reward_program_versions','club_leaderboard_settings',
    'promotions','bbj_pools','spin_bonus_pools','spin_reserve_ledger','leaderboard_payout_batches',
    'leaderboard_payouts','leaderboard_payout_failures','player_stats_snapshots'] LOOP
    EXECUTE format('SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.%I t',relation) INTO rows;
    image:=image||jsonb_build_object(relation,rows);
  END LOOP;
  RETURN md5(image::text);
END $digest$;
DO $prepare$
DECLARE club constant uuid:='92000000-0000-4000-8000-000000000002';
  operation uuid:=gen_random_uuid(); opened jsonb; opening_replay jsonb; publication_replay jsonb;
  expected_version integer; starts date; ends date; monthly_next date; historical_program uuid:=gen_random_uuid();
  version_number integer; terms jsonb; response jsonb; payout_replay jsonb; preimage jsonb;
  member_preimage jsonb; changed integer; established timestamptz;
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
  -- Publication starts next round. Only this disposable bootstrap may prepare
  -- the same historical program convention as the original payout baseline.
  -- Paid records are never inserted: the ORIGINAL payout produces them.
  IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_payout_leaderboard(uuid,text,text,timestamptz,timestamptz)'::regprocedure))
       <>'2ba8db49240eac826b2f3efe0e262648'
    OR EXISTS(SELECT 1 FROM public.leaderboard_payout_batches)
    OR EXISTS(SELECT 1 FROM public.leaderboard_payouts)
    OR EXISTS(SELECT 1 FROM public.player_stats_snapshots) THEN
    RAISE EXCEPTION 'Exact original unpaid historical fixture required';
  END IF;
  SELECT start_date,end_date INTO STRICT starts,ends FROM public.fn_leaderboard_period_window('weekly',-1);
  SELECT end_date INTO STRICT monthly_next FROM public.fn_leaderboard_period_window('monthly',0);
  established:=(starts-1)::timestamp AT TIME ZONE 'UTC';
  SELECT to_jsonb(c)-'created_at' INTO STRICT preimage FROM public.clubs c WHERE id=club
    AND created_at>=transaction_timestamp() AND created_at<=clock_timestamp();
  UPDATE public.clubs SET created_at=established WHERE id=club;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 OR (SELECT to_jsonb(c)-'created_at' FROM public.clubs c WHERE id=club) IS DISTINCT FROM preimage THEN
    RAISE EXCEPTION 'Historical club chronology changed other fixture fields';
  END IF;
  SELECT to_jsonb(m)-'joined_at' INTO STRICT member_preimage FROM public.club_members m
    WHERE club_id=club AND user_id='90000000-0000-4000-8000-000000000004'
      AND joined_at>=transaction_timestamp() AND joined_at<=clock_timestamp()
      AND role::text='player' AND status::text IN ('active','approved') AND chip_balance=0;
  UPDATE public.club_members SET joined_at=established WHERE club_id=club
    AND user_id='90000000-0000-4000-8000-000000000004';
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 OR (SELECT to_jsonb(m)-'joined_at' FROM public.club_members m WHERE club_id=club
    AND user_id='90000000-0000-4000-8000-000000000004') IS DISTINCT FROM member_preimage THEN
    RAISE EXCEPTION 'Historical member chronology changed other fixture fields';
  END IF;
  SELECT max(version)+1 INTO STRICT version_number FROM public.leaderboard_reward_program_versions WHERE club_id=club;
  terms:=jsonb_build_object('club_id',club,'version',version_number,'rewards_enabled',true,
    'payout_metric','profit','weekly_prizes','[{"rank":1,"amount":10}]'::jsonb,'monthly_prizes','[]'::jsonb,
    'funding_owner_type','club','funding_union_id',NULL,'weekly_effective_from',starts,'monthly_effective_from',monthly_next);
  INSERT INTO public.leaderboard_reward_program_versions(id,club_id,version,operation_id,rewards_enabled,payout_metric,
    weekly_prizes,monthly_prizes,suggestion_key,funding_owner_type,funding_union_id,weekly_effective_from,
    monthly_effective_from,published_by,program_hash,overlay_enabled)
  VALUES(historical_program,club,version_number,gen_random_uuid(),true,'profit','[{"rank":1,"amount":10}]','[]',
    'custom','club',NULL,starts,monthly_next,'90000000-0000-4000-8000-000000000002',md5(terms::text),true);
  IF public.fn_get_leaderboard_reward_plan(club,'weekly',starts)->>'program_id' IS DISTINCT FROM historical_program::text THEN
    RAISE EXCEPTION 'Actual historical plan differs';
  END IF;
  INSERT INTO public.player_stats_snapshots(user_id,club_id,snapshot_date,hands_played,hands_dealt,sum_big_blind,
    total_winnings,total_losses,total_rake,tournaments_played,tournaments_won)
  VALUES('90000000-0000-4000-8000-000000000004',club,starts,0,0,0,0,0,0,0,0),
    ('90000000-0000-4000-8000-000000000004',club,ends,20,20,40,100,0,0,0,0);
  response:=public.fn_payout_leaderboard(club,'weekly','profit',starts::timestamp AT TIME ZONE 'UTC',ends::timestamp AT TIME ZONE 'UTC');
  payout_replay:=public.fn_payout_leaderboard(club,'weekly','profit',starts::timestamp AT TIME ZONE 'UTC',ends::timestamp AT TIME ZONE 'UTC');
  IF (response->>'success')::boolean IS DISTINCT FROM true OR (response->>'already_settled')::boolean IS DISTINCT FROM false
    OR (response->>'total_paid')::numeric IS DISTINCT FROM 10 OR (response->>'seed_funded')::numeric IS DISTINCT FROM 10
    OR (response->>'promo_funded')::numeric IS DISTINCT FROM 0 OR (response->>'overlay_funded')::numeric IS DISTINCT FROM 0
    OR (payout_replay->>'already_settled')::boolean IS DISTINCT FROM true
    OR payout_replay->>'batch_id' IS DISTINCT FROM response->>'batch_id'
    OR (SELECT count(*) FROM public.leaderboard_payout_batches WHERE id=(response->>'batch_id')::uuid
      AND club_id=club AND period='weekly' AND period_start=starts AND period_end=ends AND program_id=historical_program)<>1
    OR (SELECT count(*) FROM public.leaderboard_payout_batches)<>1
    OR (SELECT count(*) FROM public.leaderboard_payouts)<>1
    OR (SELECT count(*) FROM public.leaderboard_payouts WHERE batch_id=(response->>'batch_id')::uuid
      AND user_id='90000000-0000-4000-8000-000000000004' AND payout_amount=10)<>1
    OR (SELECT chip_balance FROM public.club_members WHERE club_id=club
      AND user_id='90000000-0000-4000-8000-000000000004') IS DISTINCT FROM 10
    OR (SELECT leaderboard_seed_remaining FROM public.club_opening_setups WHERE club_id=club) IS DISTINCT FROM 0
    OR (SELECT chip_treasury FROM public.clubs WHERE id=club) IS DISTINCT FROM 99900
    OR (SELECT promo_balance FROM public.clubs WHERE id=club) IS DISTINCT FROM 90 THEN
    RAISE EXCEPTION 'Original real paid historical evidence differs';
  END IF;
  SET CONSTRAINTS ALL IMMEDIATE;
  INSERT INTO leaderboard_historical_fixture.proof VALUES(operation,opening_replay,publication_replay,payout_replay,starts,ends,
    leaderboard_historical_fixture.digest());
END $prepare$;
COMMIT;
\else
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
SELECT set_config('leaderboard_test.opening_body_md5', :'candidate_opening_body_md5', true);
SELECT set_config('leaderboard_test.publish_body_md5', :'candidate_publish_body_md5', true);
SELECT set_config('leaderboard_test.payout_body_md5', :'candidate_payout_body_md5', true);
DO $verify$
DECLARE club constant uuid:='92000000-0000-4000-8000-000000000002';
  proof leaderboard_historical_fixture.proof%ROWTYPE; opening_replay jsonb; publication_replay jsonb;
  expected_version integer; rejected boolean:=false; payout_replay jsonb;
BEGIN
  IF session_user<>'leaderboard_qualification_bootstrap' OR current_user<>session_user
    OR inet_server_addr() IS NOT NULL OR current_database()<>'postgres'
    OR (SELECT count(*) FROM auth.users)<>5 OR (SELECT count(*) FROM public.clubs)<>3
    OR (SELECT count(*) FROM leaderboard_historical_fixture.proof)<>1
    OR current_setting('leaderboard_test.opening_body_md5') !~ '^[0-9a-f]{32}$'
    OR current_setting('leaderboard_test.publish_body_md5') !~ '^[0-9a-f]{32}$'
    OR current_setting('leaderboard_test.payout_body_md5') !~ '^[0-9a-f]{32}$'
    OR current_setting('leaderboard_test.payout_body_md5')='2ba8db49240eac826b2f3efe0e262648'
    OR md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_payout_leaderboard(uuid,text,text,timestamptz,timestamptz)'::regprocedure))
       <>current_setting('leaderboard_test.payout_body_md5')
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
  payout_replay:=public.fn_payout_leaderboard(club,'weekly','profit',proof.period_start::timestamp AT TIME ZONE 'UTC',proof.period_end::timestamp AT TIME ZONE 'UTC');
  SET CONSTRAINTS ALL IMMEDIATE;
  IF NOT rejected OR opening_replay IS DISTINCT FROM proof.opening_replay
    OR publication_replay IS DISTINCT FROM proof.publication_replay
    OR payout_replay IS DISTINCT FROM proof.payout_replay
    OR leaderboard_historical_fixture.digest() IS DISTINCT FROM proof.image THEN
    RAISE EXCEPTION 'Historical replay or atomic new-overlay refusal differs';
  END IF;
END $verify$;
SELECT 'HISTORICAL_REPLAY|PASS';
ROLLBACK;
\endif
