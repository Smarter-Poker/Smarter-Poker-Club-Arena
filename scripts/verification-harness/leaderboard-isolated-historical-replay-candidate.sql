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
  publication_replay jsonb, payout_replay jsonb, period_start date, period_end date,
  monthly_program uuid NOT NULL, monthly_version integer NOT NULL, monthly_hash text NOT NULL,
  monthly_start date NOT NULL, monthly_end date NOT NULL, monthly_board jsonb NOT NULL,
  image text NOT NULL);
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
  monthly_start date; monthly_end date; weekly_next date; monthly_program uuid:=gen_random_uuid();
  monthly_version integer; monthly_terms jsonb; monthly_board jsonb;
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
  SELECT start_date,end_date INTO STRICT monthly_start,monthly_end FROM public.fn_leaderboard_period_window('monthly',-2);
  SELECT end_date INTO STRICT weekly_next FROM public.fn_leaderboard_period_window('weekly',0);
  SELECT end_date INTO STRICT monthly_next FROM public.fn_leaderboard_period_window('monthly',0);
  established:=(least(starts,monthly_start)-1)::timestamp AT TIME ZONE 'UTC';
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
  -- A second ORIGINAL immutable program remains UNPAID through installation.
  -- Monthly -2 is older than weekly -1 at every calendar position, so its
  -- two synthetic snapshot dates cannot overwrite the paid weekly inputs.
  -- These are controlled historical terms/counters, NOT historical cron proof.
  IF monthly_end>=starts OR monthly_start>=monthly_end
    OR EXISTS(SELECT 1 FROM public.player_stats_snapshots WHERE club_id=club
      AND snapshot_date IN(monthly_start,monthly_end)) THEN
    RAISE EXCEPTION 'Separate unpaid canonical monthly fixture required';
  END IF;
  SELECT max(version)+1 INTO STRICT monthly_version FROM public.leaderboard_reward_program_versions WHERE club_id=club;
  monthly_terms:=jsonb_build_object('club_id',club,'version',monthly_version,'rewards_enabled',true,
    'payout_metric','profit','weekly_prizes','[]'::jsonb,'monthly_prizes','[{"rank":1,"amount":10}]'::jsonb,
    'funding_owner_type','club','funding_union_id',NULL,'weekly_effective_from',weekly_next,'monthly_effective_from',monthly_start);
  INSERT INTO public.leaderboard_reward_program_versions(id,club_id,version,operation_id,rewards_enabled,payout_metric,
    weekly_prizes,monthly_prizes,suggestion_key,funding_owner_type,funding_union_id,weekly_effective_from,
    monthly_effective_from,published_by,program_hash,overlay_enabled)
  VALUES(monthly_program,club,monthly_version,gen_random_uuid(),true,'profit','[]','[{"rank":1,"amount":10}]',
    'custom','club',NULL,weekly_next,monthly_start,'90000000-0000-4000-8000-000000000002',md5(monthly_terms::text),false);
  INSERT INTO public.player_stats_snapshots(user_id,club_id,snapshot_date,hands_played,hands_dealt,sum_big_blind,
    total_winnings,total_losses,total_rake,tournaments_played,tournaments_won)
  VALUES('90000000-0000-4000-8000-000000000004',club,monthly_start,0,0,0,0,0,0,0,0),
    ('90000000-0000-4000-8000-000000000004',club,monthly_end,20,20,40,100,0,0,0,0);
  monthly_board:=jsonb_build_array(jsonb_build_object('user_id','90000000-0000-4000-8000-000000000004',
    'hands_played',20,'total_winnings',100,'total_losses',0,'tournaments_won',0,'total_rake',0,'sum_big_blind',40,
    'rank_change',0,'qualified',true,'rank',1,'total_ranked',1,'baseline_date',monthly_start));
  IF public.fn_get_leaderboard_reward_plan(club,'monthly',monthly_start)->>'program_id' IS DISTINCT FROM monthly_program::text
    OR EXISTS(SELECT 1 FROM public.leaderboard_payout_batches WHERE club_id=club AND period='monthly') THEN
    RAISE EXCEPTION 'Original unpaid monthly program selection differs';
  END IF;
  SET CONSTRAINTS ALL IMMEDIATE;
  INSERT INTO leaderboard_historical_fixture.proof VALUES(operation,opening_replay,publication_replay,payout_replay,starts,ends,
    monthly_program,monthly_version,md5(monthly_terms::text),monthly_start,monthly_end,monthly_board,
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
<<legacy_verify>>
DECLARE club constant uuid:='92000000-0000-4000-8000-000000000002';
  proof leaderboard_historical_fixture.proof%ROWTYPE; opening_replay jsonb; publication_replay jsonb;
  expected_version integer; rejected boolean:=false; payout_replay jsonb;
  response jsonb; replay jsonb; monthly_plan jsonb; basis jsonb; board jsonb; winners jsonb;
  original_batch jsonb; original_payouts jsonb; receipt jsonb; paid_image text; correlation uuid;
  legacy_passed boolean:=false;
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
  -- Existing-club inventory was captured by the EXACT candidate installation.
  -- Exercise both independent canonical cutoffs without time-warping immutable
  -- rollout metadata, creating complete captures, or changing financial terms.
  IF NOT EXISTS(SELECT 1 FROM public.leaderboard_basis_existing_clubs WHERE club_id=club)
    OR NOT EXISTS(SELECT 1 FROM public.leaderboard_basis_rollout WHERE singleton
      AND proof.period_start<weekly_v2_from AND proof.monthly_start<monthly_v2_from)
    OR proof.monthly_end>(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
    OR extract(day FROM proof.monthly_start)<>1
    OR proof.monthly_end<>(proof.monthly_start+interval '1 month')::date
    OR EXISTS(SELECT 1 FROM public.leaderboard_complete_captures)
    OR EXISTS(SELECT 1 FROM public.leaderboard_capture_counters)
    OR EXISTS(SELECT 1 FROM public.leaderboard_round_basis_receipts) THEN
    RAISE EXCEPTION 'Exact existing-club legacy rollout fixture required';
  END IF;
  IF public.fn_leaderboard_complete_round_basis(club,'weekly',proof.period_start,proof.period_end)
       IS DISTINCT FROM '{"basis_version":"legacy_v1","complete":false}'::jsonb
    OR public.fn_leaderboard_complete_round_basis(club,'monthly',proof.monthly_start,proof.monthly_end)
       IS DISTINCT FROM '{"basis_version":"legacy_v1","complete":false}'::jsonb THEN
    RAISE EXCEPTION 'Existing weekly or monthly terms were misclassified as complete';
  END IF;
  -- This new settlement and its replay self-abort even on PASS. The prior paid
  -- history remains untouched, and the final outer ROLLBACK still owns cleanup.
  BEGIN
    SELECT to_jsonb(b) INTO STRICT original_batch FROM public.leaderboard_payout_batches b
      WHERE b.id=(proof.payout_replay->>'batch_id')::uuid;
    SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) INTO original_payouts FROM public.leaderboard_payouts p
      WHERE p.batch_id=(proof.payout_replay->>'batch_id')::uuid;
    monthly_plan:=public.fn_get_leaderboard_reward_plan(club,'monthly',proof.monthly_start);
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.rank,r.user_id),'[]'::jsonb) INTO board
      FROM public.fn_club_leaderboard_by_dates(club,'profit',proof.monthly_start,proof.monthly_end,1000000,0) r;
    basis:='{"basis_version":"legacy_v1","complete":false}'::jsonb;
    winners:='[{"user_id":"90000000-0000-4000-8000-000000000004","rank":1,"amount":10}]'::jsonb;
    IF board IS DISTINCT FROM proof.monthly_board
      OR monthly_plan->>'program_id' IS DISTINCT FROM proof.monthly_program::text
      OR (monthly_plan->>'program_version')::integer IS DISTINCT FROM proof.monthly_version
      OR monthly_plan->>'program_hash' IS DISTINCT FROM proof.monthly_hash
      OR monthly_plan->'prizes' IS DISTINCT FROM '[{"rank":1,"amount":10}]'::jsonb
      OR (SELECT count(*) FROM public.leaderboard_payout_batches)<>1 THEN
      RAISE EXCEPTION 'Independently expected unpaid legacy board or original terms differ';
    END IF;
    correlation:=gen_random_uuid(); PERFORM set_config('app.ledger_correlation',correlation::text,true);
    PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
    PERFORM set_config('request.jwt.claim.sub','',true);
    PERFORM set_config('request.jwt.claim.role','service_role',true);
    SET LOCAL ROLE service_role;
    response:=public.fn_payout_leaderboard(club,'monthly','profit',
      proof.monthly_start::timestamp AT TIME ZONE 'UTC',proof.monthly_end::timestamp AT TIME ZONE 'UTC');
    RESET ROLE;
    IF (response->>'success')::boolean IS DISTINCT FROM true
      OR (response->>'already_settled')::boolean IS DISTINCT FROM false
      OR (response->>'total_paid')::numeric IS DISTINCT FROM 10
      OR (response->>'promo_funded')::numeric IS DISTINCT FROM 10
      OR (response->>'seed_funded')::numeric IS DISTINCT FROM 0
      OR (response->>'overlay_funded')::numeric IS DISTINCT FROM 0
      OR (response->>'winner_count')::integer IS DISTINCT FROM 1
      OR (SELECT chip_treasury FROM public.clubs WHERE id=club) IS DISTINCT FROM 99900
      OR (SELECT promo_balance FROM public.clubs WHERE id=club) IS DISTINCT FROM 80
      OR (SELECT leaderboard_seed_remaining FROM public.club_opening_setups WHERE club_id=club) IS DISTINCT FROM 0
      OR (SELECT chip_balance FROM public.club_members WHERE club_id=club
        AND user_id='90000000-0000-4000-8000-000000000004') IS DISTINCT FROM 20
      OR (SELECT count(*) FROM public.leaderboard_payout_batches)<>2
      OR (SELECT count(*) FROM public.leaderboard_payouts)<>2
      OR (SELECT count(*) FROM public.leaderboard_payout_batches WHERE id=(response->>'batch_id')::uuid
        AND club_id=club AND period='monthly' AND period_start=proof.monthly_start AND period_end=proof.monthly_end
        AND program_id=proof.monthly_program AND program_version=proof.monthly_version AND program_hash=proof.monthly_hash
        AND total_paid=10 AND promo_funded=10 AND seed_funded=0 AND overlay_funded=0 AND winner_count=1)<>1
      OR (SELECT count(*) FROM public.leaderboard_payouts WHERE batch_id=(response->>'batch_id')::uuid
        AND user_id='90000000-0000-4000-8000-000000000004' AND rank=1 AND payout_amount=10)<>1
      OR (SELECT count(*) FROM public.wallet_credit_idempotency WHERE key=format('leaderboard:%s:monthly:%s:%s',
        club,proof.monthly_start,'90000000-0000-4000-8000-000000000004')
        AND user_id='90000000-0000-4000-8000-000000000004' AND amount=10)<>1
      OR (SELECT count(*) FROM public.wallet_transactions WHERE related_entity_id=proof.monthly_program
        AND category='leaderboard_payout' AND user_id='90000000-0000-4000-8000-000000000004'
        AND amount=10 AND type='credit')<>1 THEN
      RAISE EXCEPTION 'New legacy settlement Promo-only conservation or durable receipts differ';
    END IF;
    SELECT to_jsonb(r) INTO STRICT receipt FROM public.leaderboard_round_basis_receipts r
      WHERE r.club_id=club AND r.period='monthly' AND r.period_start=proof.monthly_start
        AND r.period_end=proof.monthly_end AND r.metric='profit'
        AND r.program_id=proof.monthly_program AND r.program_version=proof.monthly_version AND r.program_hash=proof.monthly_hash
        AND r.basis_version='legacy_v1' AND r.basis=legacy_verify.basis AND r.basis_hash=md5(legacy_verify.basis::text)
        -- JSONB numeric equality ignores presentation scale; hashes must seal
        -- the ACTUAL resolved bytes (10.00), not the literal expected scale (10).
        AND r.selected_board=proof.monthly_board AND r.selected_board_hash=md5(r.selected_board::text)
        AND r.winners=legacy_verify.winners AND r.winners_hash=md5(r.winners::text);
    IF (SELECT count(*) FROM public.leaderboard_round_basis_receipts)<>1
      OR (SELECT count(*) FROM public.chip_ledger WHERE correlation_id=correlation)<>2
      OR (SELECT count(*) FROM public.chip_ledger WHERE correlation_id=correlation AND category='leaderboard_payout'
        AND from_type='promo_wallet' AND from_entity_id=club AND to_type='leaderboard_round' AND to_entity_id=club
        AND amount=10 AND pre_from_balance=90 AND post_from_balance=80)<>1
      OR (SELECT count(*) FROM public.chip_ledger WHERE correlation_id=correlation AND category='leaderboard_payout'
        AND from_type='leaderboard_round' AND from_entity_id=club AND to_type='player_wallet'
        AND to_entity_id='90000000-0000-4000-8000-000000000004'
        AND amount=10 AND pre_to_balance=10 AND post_to_balance=20)<>1
      OR (SELECT to_jsonb(b) FROM public.leaderboard_payout_batches b WHERE b.id=(proof.payout_replay->>'batch_id')::uuid)
        IS DISTINCT FROM original_batch
      OR (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.leaderboard_payouts p
        WHERE p.batch_id=(proof.payout_replay->>'batch_id')::uuid) IS DISTINCT FROM original_payouts THEN
      RAISE EXCEPTION 'Legacy settlement journal or prior immutable paid history differs';
    END IF;
    paid_image:=leaderboard_historical_fixture.digest();
    SET LOCAL ROLE service_role;
    replay:=public.fn_payout_leaderboard(club,'monthly','profit',
      proof.monthly_start::timestamp AT TIME ZONE 'UTC',proof.monthly_end::timestamp AT TIME ZONE 'UTC');
    RESET ROLE;
    IF (replay->>'already_settled')::boolean IS DISTINCT FROM true
      OR replay->>'batch_id' IS DISTINCT FROM response->>'batch_id'
      OR leaderboard_historical_fixture.digest() IS DISTINCT FROM paid_image
      OR (SELECT to_jsonb(r) FROM public.leaderboard_round_basis_receipts r WHERE r.club_id=club
        AND r.period='monthly' AND r.period_start=proof.monthly_start) IS DISTINCT FROM receipt THEN
      RAISE EXCEPTION 'New legacy settlement replay changed money or immutable basis';
    END IF;
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION USING ERRCODE='Q0004',MESSAGE='UnpaidLegacySettlementPassedAndRolledBack';
  EXCEPTION WHEN SQLSTATE 'Q0004' THEN legacy_passed:=true;
  END;
  IF NOT legacy_passed OR leaderboard_historical_fixture.digest() IS DISTINCT FROM proof.image
    OR EXISTS(SELECT 1 FROM public.leaderboard_round_basis_receipts) THEN
    RAISE EXCEPTION 'Unpaid legacy settlement did not roll back to exact historical preimage';
  END IF;
END $verify$;
SELECT 'HISTORICAL_REPLAY|PASS';
ROLLBACK;
\endif
