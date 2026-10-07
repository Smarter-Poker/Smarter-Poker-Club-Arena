-- UNQUALIFIED disposable-only fixture, never execute on source/production.
-- Separate compatibility/producer mode: existing synthetic authorizer FIRST,
-- then capture candidate installation inventory, then this fixture. Whole
-- disposable runtime owns cleanup. No legacy fixture or inventory is changed.
-- Payout integration uses the separate capture-payout-fixture adapter with
-- the opposite installation order (candidate BEFORE synthetic new clubs).
-- Synthetic historical captures below do NOT prove actual historical producer
-- execution. Actual producer is exercised only on the real current day.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
SET LOCAL TIME ZONE 'UTC';
DO $guard$
BEGIN
  IF session_user<>'leaderboard_qualification_bootstrap' OR current_user<>session_user
     OR inet_server_addr() IS NOT NULL OR current_database()<>'postgres'
     OR (SELECT count(*) FROM auth.users)<>5
     OR EXISTS(SELECT 1 FROM auth.users WHERE id::text NOT LIKE '90000000-0000-4000-8000-%')
     OR (SELECT count(*) FROM public.clubs)<>3
     OR (SELECT array_agg(club_id::text ORDER BY club_id::text) FROM public.leaderboard_basis_existing_clubs)
       IS DISTINCT FROM ARRAY['91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000002']::text[]
     OR EXISTS(SELECT 1 FROM public.player_stats WHERE club_id IS NOT NULL)
     OR EXISTS(SELECT 1 FROM public.leaderboard_complete_captures)
     OR EXISTS(SELECT 1 FROM public.leaderboard_capture_counters)
     OR EXISTS(SELECT 1 FROM public.leaderboard_round_basis_receipts)
     OR EXISTS(SELECT 1 FROM public.leaderboard_payout_batches) THEN
    RAISE EXCEPTION 'Exact fresh disposable capture compatibility fixture required';
  END IF;
END $guard$;

-- Actual nonempty producer proof, isolated from the retained empty-day proof.
-- A deliberate subtransaction rollback removes ONLY this synthetic input and
-- its resulting captures; never delete or rewrite immutable capture history.
DO $nonempty_producer$
DECLARE result jsonb; expected jsonb; frozen_header jsonb; frozen_rows jsonb;
BEGIN
  BEGIN
    INSERT INTO public.player_stats(user_id,club_id,hands_played,hands_dealt,
      sum_big_blind,total_winnings,total_losses,total_rake,tournaments_played,tournaments_won)
    VALUES('90000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000002',
      11,13,26,101.25,12.50,1.75,3,1);
    expected:=jsonb_build_array(jsonb_build_object(
      'user_id','90000000-0000-4000-8000-000000000002',
      'club_id','92000000-0000-4000-8000-000000000002',
      'hands_played',11,'hands_dealt',13,'sum_big_blind',26,
      'total_winnings',101.25,'total_losses',12.50,'total_rake',1.75,
      'tournaments_played',3,'tournaments_won',1));
    result:=public.fn_snapshot_player_stats();
    IF result->'success' IS DISTINCT FROM 'true'::jsonb
      OR result->'rows' IS DISTINCT FROM '1'::jsonb
      OR result->>'date' IS DISTINCT FROM CURRENT_DATE::text
      OR (SELECT jsonb_agg(to_jsonb(c)-'snapshot_date' ORDER BY club_id,user_id)
          FROM public.leaderboard_capture_counters c) IS DISTINCT FROM expected
      OR (SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'club_id',club_id,
          'hands_played',hands_played,'hands_dealt',hands_dealt,'sum_big_blind',sum_big_blind,
          'total_winnings',total_winnings,'total_losses',total_losses,'total_rake',total_rake,
          'tournaments_played',tournaments_played,'tournaments_won',tournaments_won)
          ORDER BY club_id,user_id) FROM public.player_stats_snapshots
          WHERE snapshot_date=CURRENT_DATE) IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'Actual nonempty producer counter and shared snapshot values differ';
    END IF;
    SELECT to_jsonb(c) INTO STRICT frozen_header FROM public.leaderboard_complete_captures c
      WHERE capture_date=CURRENT_DATE AND complete AND row_count=1
        AND counter_hash=md5((expected->0)::text)
        AND origin='fn_snapshot_player_stats' AND source_contract='applied_player_stats_v1'
        AND capture_timezone='UTC' AND captured_at>=transaction_timestamp()
        AND captured_at<=clock_timestamp()
        AND (captured_at AT TIME ZONE 'UTC')::date=capture_date;
    SELECT jsonb_agg(to_jsonb(c) ORDER BY club_id,user_id) INTO frozen_rows
      FROM public.leaderboard_capture_counters c;
    UPDATE public.player_stats SET total_winnings=202.50
      WHERE user_id='90000000-0000-4000-8000-000000000002'
        AND club_id='92000000-0000-4000-8000-000000000002';
    result:=public.fn_snapshot_player_stats();
    IF result->'rows' IS DISTINCT FROM '1'::jsonb
      OR (SELECT to_jsonb(c) FROM public.leaderboard_complete_captures c
          WHERE capture_date=CURRENT_DATE) IS DISTINCT FROM frozen_header
      OR (SELECT jsonb_agg(to_jsonb(c) ORDER BY club_id,user_id)
          FROM public.leaderboard_capture_counters c) IS DISTINCT FROM frozen_rows
      OR (SELECT total_winnings FROM public.player_stats_snapshots
          WHERE user_id='90000000-0000-4000-8000-000000000002'
            AND club_id='92000000-0000-4000-8000-000000000002'
            AND snapshot_date=CURRENT_DATE) IS DISTINCT FROM 202.50 THEN
      RAISE EXCEPTION 'Repeated nonempty producer changed frozen capture or failed shared upsert';
    END IF;
    RAISE EXCEPTION USING ERRCODE='Q0003',MESSAGE='NonemptyProducerPassedAndRolledBack';
  EXCEPTION WHEN SQLSTATE 'Q0003' THEN NULL;
  END;
  IF EXISTS(SELECT 1 FROM public.player_stats WHERE club_id IS NOT NULL)
    OR EXISTS(SELECT 1 FROM public.player_stats_snapshots)
    OR EXISTS(SELECT 1 FROM public.leaderboard_complete_captures)
    OR EXISTS(SELECT 1 FROM public.leaderboard_capture_counters) THEN
    RAISE EXCEPTION 'Nonempty producer subtransaction did not restore exact empty preimage';
  END IF;
END $nonempty_producer$;

DO $producer$
DECLARE rejected boolean:=false; result jsonb; first_header jsonb; zone text;
BEGIN
  zone:=CASE WHEN (clock_timestamp() AT TIME ZONE 'UTC')::time>=time '10:00'
    THEN 'Etc/GMT-14' ELSE 'Etc/GMT+12' END;
  BEGIN
    PERFORM set_config('TimeZone',zone,true);
    PERFORM public.fn_snapshot_player_stats();
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM IS DISTINCT FROM 'LEADERBOARD_CAPTURE_DATE_CONTRACT_MISMATCH' THEN RAISE; END IF;
    rejected:=true;
  END;
  IF NOT rejected OR EXISTS(SELECT 1 FROM public.leaderboard_complete_captures)
     OR EXISTS(SELECT 1 FROM public.player_stats_snapshots) THEN
    RAISE EXCEPTION 'First capture date mismatch was not refused before all writes';
  END IF;
  PERFORM set_config('TimeZone','UTC',true);
  result:=public.fn_snapshot_player_stats();
  IF result->'success' IS DISTINCT FROM 'true'::jsonb OR result->'rows' IS DISTINCT FROM '0'::jsonb
     OR result->>'date' IS DISTINCT FROM CURRENT_DATE::text THEN
    RAISE EXCEPTION 'Actual complete empty producer return contract differs';
  END IF;
  SELECT to_jsonb(c) INTO STRICT first_header FROM public.leaderboard_complete_captures c
    WHERE capture_date=CURRENT_DATE AND complete AND row_count=0 AND counter_hash=md5('')
      AND captured_at>=transaction_timestamp() AND captured_at<=clock_timestamp()
      AND (captured_at AT TIME ZONE 'UTC')::date=capture_date;
  PERFORM public.fn_snapshot_player_stats();
  IF (SELECT to_jsonb(c) FROM public.leaderboard_complete_captures c WHERE capture_date=CURRENT_DATE)
     IS DISTINCT FROM first_header OR EXISTS(SELECT 1 FROM public.leaderboard_capture_counters) THEN
    RAISE EXCEPTION 'Repeated actual producer replaced first complete capture';
  END IF;
END $producer$;

-- New synthetic Union house has no opening chip grant. This tests new-club
-- inventory classification, not a different asset or a paid Union settlement.
INSERT INTO public.unions(id,name,owner_id,slug)
VALUES('97000000-0000-4000-8000-000000000001','Isolated Capture Union',
  '90000000-0000-4000-8000-000000000001','isolated-capture-union');
INSERT INTO public.clubs(id,name,owner_id,is_union,union_id)
VALUES('97000000-0000-4000-8000-000000000001','Isolated Capture House',
  '90000000-0000-4000-8000-000000000001',true,NULL);
DO $new_club$
BEGIN
  IF EXISTS(SELECT 1 FROM public.leaderboard_basis_existing_clubs WHERE club_id='97000000-0000-4000-8000-000000000001')
     OR NOT EXISTS(SELECT 1 FROM public.clubs WHERE id='97000000-0000-4000-8000-000000000001'
       AND is_union AND chip_treasury=0 AND promo_balance=0) THEN
    RAISE EXCEPTION 'New synthetic Union-house classification or zero funding differs';
  END IF;
END $new_club$;

CREATE TEMP TABLE lb_capture_verdicts(case_name text PRIMARY KEY,passed boolean,sqlstate text);
DO $cases$
DECLARE case_name text; starts date; ends date; basis jsonb; rejected boolean;
  new_club constant uuid:='97000000-0000-4000-8000-000000000001';
  legacy_club constant uuid:='92000000-0000-4000-8000-000000000002';
  state text; original jsonb; program public.leaderboard_reward_program_versions%ROWTYPE;
BEGIN
  SELECT start_date,end_date INTO starts,ends FROM public.fn_leaderboard_period_window('weekly',-2);
  FOREACH case_name IN ARRAY ARRAY['existing_club_legacy_is_explicit','missing_boundary_refuses',
    'complete_empty_is_not_missing','individual_zero_requires_complete_opening',
    'canonical_closed_window_refuses','capture_and_receipt_are_immutable'] LOOP
    BEGIN
      IF case_name='existing_club_legacy_is_explicit' THEN
        basis:=public.fn_leaderboard_complete_round_basis(legacy_club,'weekly',starts,ends);
        IF basis IS DISTINCT FROM '{"basis_version":"legacy_v1","complete":false}'::jsonb THEN
          RAISE EXCEPTION 'Existing promised legacy selection was misclassified complete';
        END IF;
      ELSIF case_name IN ('missing_boundary_refuses','canonical_closed_window_refuses') THEN
        rejected:=false;
        BEGIN
          basis:=public.fn_leaderboard_complete_round_basis(new_club,'weekly',starts,
            CASE WHEN case_name='canonical_closed_window_refuses' THEN ends-1 ELSE ends END);
        EXCEPTION WHEN SQLSTATE '55000' OR SQLSTATE '22023' THEN
          IF SQLERRM IS DISTINCT FROM CASE WHEN case_name='canonical_closed_window_refuses'
             THEN 'LEADERBOARD_BASIS_WINDOW_INVALID' ELSE 'LEADERBOARD_CAPTURE_UNAVAILABLE' END THEN RAISE; END IF;
          rejected:=true;
        END;
        IF NOT rejected OR EXISTS(SELECT 1 FROM public.leaderboard_round_basis_receipts)
           OR EXISTS(SELECT 1 FROM public.leaderboard_payout_batches) THEN
          RAISE EXCEPTION 'Missing or invalid basis did not refuse without settlement records';
        END IF;
      ELSE
        INSERT INTO public.leaderboard_complete_captures
          (capture_date,captured_at,capture_timezone,origin,source_contract,row_count,counter_hash,complete)
        VALUES(starts,(starts+time '00:05') AT TIME ZONE 'UTC','UTC','fn_snapshot_player_stats','applied_player_stats_v1',0,md5(''),true),
          (ends,(ends+time '00:05') AT TIME ZONE 'UTC','UTC','fn_snapshot_player_stats','applied_player_stats_v1',0,md5(''),true);
        basis:=public.fn_leaderboard_complete_round_basis(new_club,'weekly',starts,ends);
        IF basis->>'basis_version' IS DISTINCT FROM 'complete_capture_v2'
           OR basis->'complete' IS DISTINCT FROM 'true'::jsonb OR basis->'rows' IS DISTINCT FROM '[]'::jsonb THEN
          RAISE EXCEPTION 'Proven complete empty capture was not a valid empty v2 basis';
        END IF;
        IF case_name='individual_zero_requires_complete_opening' THEN
          -- Do not rewrite an immutable empty header to add a counter. This
          -- nested subtransaction discards the first synthetic empty case.
          RAISE EXCEPTION USING ERRCODE='Q0002',MESSAGE='RequiresSeparateNonemptyCaptureCase';
        ELSIF case_name='capture_and_receipt_are_immutable' THEN
          rejected:=false;
          BEGIN UPDATE public.leaderboard_complete_captures SET row_count=1 WHERE capture_date=starts;
          EXCEPTION WHEN SQLSTATE '55000' THEN
            IF SQLERRM IS DISTINCT FROM 'LEADERBOARD_BASIS_IMMUTABLE' THEN RAISE; END IF; rejected:=true;
          END;
          IF NOT rejected THEN RAISE EXCEPTION 'Capture mutation unexpectedly accepted'; END IF;
          SELECT * INTO STRICT program FROM public.leaderboard_reward_program_versions
            WHERE club_id=legacy_club ORDER BY version DESC LIMIT 1;
          -- Constraint/immutability test receipt only, NOT an actual payout.
          INSERT INTO public.leaderboard_round_basis_receipts(club_id,period,period_start,period_end,
            program_id,program_version,program_hash,metric,basis_version,basis,basis_hash,
            selected_board,selected_board_hash,winners,winners_hash)
          VALUES(legacy_club,'weekly',starts,ends,program.id,program.version,program.program_hash,
            'profit','legacy_v1','{"basis_version":"legacy_v1","complete":false}',
            md5('{"basis_version":"legacy_v1","complete":false}'::jsonb::text),'[]',md5('[]'),'[]',md5('[]'));
          rejected:=false;
          BEGIN DELETE FROM public.leaderboard_round_basis_receipts WHERE club_id=legacy_club;
          EXCEPTION WHEN SQLSTATE '55000' THEN
            IF SQLERRM IS DISTINCT FROM 'LEADERBOARD_BASIS_IMMUTABLE' THEN RAISE; END IF; rejected:=true;
          END;
          IF NOT rejected THEN RAISE EXCEPTION 'Frozen receipt deletion unexpectedly accepted'; END IF;
        END IF;
      END IF;
      RAISE EXCEPTION USING ERRCODE='Q0001',MESSAGE='CaptureCasePassedAndRolledBack';
    EXCEPTION
      WHEN SQLSTATE 'Q0001' THEN INSERT INTO lb_capture_verdicts VALUES(case_name,true,NULL);
      WHEN SQLSTATE 'Q0002' THEN
        -- Prior subtransaction rolled back both immutable empty headers.
        BEGIN
          -- Header must exist before its FK counter; independently hash the
          -- exact object that the counter row will expose, not a guessed hash.
          SELECT jsonb_build_object('user_id','90000000-0000-4000-8000-000000000004','club_id',new_club,
            'hands_played',20,'hands_dealt',20,'sum_big_blind',40,'total_winnings',100,
            'total_losses',0,'total_rake',0,'tournaments_played',0,'tournaments_won',0) INTO original;
          INSERT INTO public.leaderboard_complete_captures
            (capture_date,captured_at,capture_timezone,origin,source_contract,row_count,counter_hash,complete)
          VALUES(starts,(starts+time '00:05') AT TIME ZONE 'UTC','UTC','fn_snapshot_player_stats','applied_player_stats_v1',0,md5(''),true),
            (ends,(ends+time '00:05') AT TIME ZONE 'UTC','UTC','fn_snapshot_player_stats','applied_player_stats_v1',1,md5(original::text),true);
          INSERT INTO public.leaderboard_capture_counters VALUES(ends,'90000000-0000-4000-8000-000000000004',new_club,20,20,40,100,0,0,0,0);
          rejected:=false;
          BEGIN UPDATE public.leaderboard_capture_counters SET hands_dealt=21 WHERE snapshot_date=ends;
          EXCEPTION WHEN SQLSTATE '55000' THEN
            IF SQLERRM IS DISTINCT FROM 'LEADERBOARD_BASIS_IMMUTABLE' THEN RAISE; END IF; rejected:=true;
          END;
          IF NOT rejected THEN RAISE EXCEPTION 'Captured counter mutation unexpectedly accepted'; END IF;
          basis:=public.fn_leaderboard_complete_round_basis(new_club,'weekly',starts,ends);
          IF jsonb_array_length(basis->'rows') IS DISTINCT FROM 1
             OR basis#>>'{rows,0,user_id}' IS DISTINCT FROM '90000000-0000-4000-8000-000000000004'
             OR (basis#>>'{rows,0,hands_played}')::numeric IS DISTINCT FROM 20
             OR (basis#>>'{rows,0,total_winnings}')::numeric IS DISTINCT FROM 100 THEN
            RAISE EXCEPTION 'Legitimate individual zero opening delta differs';
          END IF;
          RAISE EXCEPTION USING ERRCODE='Q0001',MESSAGE='CaptureCasePassedAndRolledBack';
        EXCEPTION WHEN SQLSTATE 'Q0001' THEN INSERT INTO lb_capture_verdicts VALUES(case_name,true,NULL);
          WHEN OTHERS THEN GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE; INSERT INTO lb_capture_verdicts VALUES(case_name,false,state);
        END;
      WHEN OTHERS THEN GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE; INSERT INTO lb_capture_verdicts VALUES(case_name,false,state);
    END;
  END LOOP;
END $cases$;
TABLE lb_capture_verdicts;
DO $verdict$ BEGIN
  IF (SELECT count(*) FROM lb_capture_verdicts)<>6 OR EXISTS(SELECT 1 FROM lb_capture_verdicts WHERE NOT passed) THEN
    RAISE EXCEPTION 'Capture candidate has unqualified failures';
  END IF;
END $verdict$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
