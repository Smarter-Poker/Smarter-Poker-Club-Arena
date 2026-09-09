-- Run as postgres only on a disposable stage-one rehearsal database with
-- dblink installed. Two hands at different tables in the same MTT must be
-- able to settle concurrently. The gate owns the four target roster rows
-- until both callers have acquired the shared tournament parent lock. With
-- the former parent-lock upgrade in the stack core, releasing that gate made
-- the callers deadlock deterministically: each retained FOR SHARE while each
-- attempted FOR UPDATE. The hard-coded authority keeps the parent lock shared,
-- so both exact protocol-2 hand transactions now finish independently.
--
-- Setup and cleanup commit through isolated dblink sessions because the two
-- tested transactions must see the fixture. Every identity is probe-specific,
-- and the exception handler removes it even when an assertion fails.
DO $accepted_hand_multitable_concurrency$
DECLARE
  v_conn text;
  v_waiters integer:=0;
  v_result_one jsonb;
  v_result_two jsonb;
  v_error_one text;
  v_error_two text;
  v_state_one text;
  v_state_two text;
  v_count integer;
BEGIN
  IF current_user<>'postgres'
     OR to_regprocedure('public.dblink_connect(text,text)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)')
          IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.tournaments
        WHERE id='30000000-0000-0000-0000-000000000001'::uuid) THEN
    RAISE EXCEPTION
      'accepted-hand multitable concurrency probe requires postgres, dblink and the disposable stage-one rehearsal database';
  END IF;

  v_conn:=format(
    'host=%s port=%s dbname=%s user=%s',
    split_part(current_setting('unix_socket_directories'),',',1),
    current_setting('port'),current_database(),session_user);

  -- Remove residue from an interrupted earlier run, then construct one four-
  -- player MTT with two independent live tables and one protocol-2 manager
  -- generation. Replica mode is fixture construction only; both hand calls
  -- below run with every production trigger enabled.
  PERFORM public.dblink_connect('accepted_hand_mt_setup',v_conn);
  PERFORM public.dblink_exec('accepted_hand_mt_setup','BEGIN');
  PERFORM public.dblink_exec(
    'accepted_hand_mt_setup','SET LOCAL session_replication_role=replica');
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.daily_challenge_event_outbox
     WHERE event_key IN (
       'hand:8e400000-0000-0000-0000-000000000001',
       'hand:8e400000-0000-0000-0000-000000000002')
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.bomb_pot_award_units
     WHERE hand_history_id IN (
       '8e400000-0000-0000-0000-000000000001'::uuid,
       '8e400000-0000-0000-0000-000000000002'::uuid)
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.hand_projection_outbox
     WHERE hand_id IN (
       '8e400000-0000-0000-0000-000000000001'::uuid,
       '8e400000-0000-0000-0000-000000000002'::uuid)
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.hand_atomic_commits
     WHERE table_id IN (
       '8e200000-0000-0000-0000-000000000001'::uuid,
       '8e200000-0000-0000-0000-000000000002'::uuid)
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.hand_history
     WHERE id IN (
       '8e400000-0000-0000-0000-000000000001'::uuid,
       '8e400000-0000-0000-0000-000000000002'::uuid)
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.ca_seat_stack_rebases
     WHERE table_id IN (
       '8e200000-0000-0000-0000-000000000001'::uuid,
       '8e200000-0000-0000-0000-000000000002'::uuid)
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.settlement_idempotency_keys
     WHERE table_id IN (
       '8e200000-0000-0000-0000-000000000001'::uuid,
       '8e200000-0000-0000-0000-000000000002'::uuid)
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.ca_settlements
     WHERE table_id IN (
       '8e200000-0000-0000-0000-000000000001'::uuid,
       '8e200000-0000-0000-0000-000000000002'::uuid)
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.tournament_manager_wakes
     WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.tournament_knockout_candidates
     WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.tournament_seat_exit_authorizations
     WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.table_seats
     WHERE table_id IN (
       '8e200000-0000-0000-0000-000000000001'::uuid,
       '8e200000-0000-0000-0000-000000000002'::uuid)
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.engine_tournament_leases
     WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.tournament_players
     WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.tables
     WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.tournaments
     WHERE id='8e000000-0000-0000-0000-000000000001'::uuid
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.profiles
     WHERE id BETWEEN
       '8e100000-0000-0000-0000-000000000001'::uuid AND
       '8e100000-0000-0000-0000-000000000004'::uuid
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM public.users
     WHERE id BETWEEN
       '8e100000-0000-0000-0000-000000000001'::uuid AND
       '8e100000-0000-0000-0000-000000000004'::uuid
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$cleanup$
    DELETE FROM auth.users
     WHERE id BETWEEN
       '8e100000-0000-0000-0000-000000000001'::uuid AND
       '8e100000-0000-0000-0000-000000000004'::uuid
  $cleanup$);

  PERFORM public.dblink_exec('accepted_hand_mt_setup',$setup$
    INSERT INTO auth.users(id) VALUES
      ('8e100000-0000-0000-0000-000000000001'),
      ('8e100000-0000-0000-0000-000000000002'),
      ('8e100000-0000-0000-0000-000000000003'),
      ('8e100000-0000-0000-0000-000000000004')
  $setup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$setup$
    INSERT INTO public.users(id,username) VALUES
      ('8e100000-0000-0000-0000-000000000001','accepted_hand_mt_1'),
      ('8e100000-0000-0000-0000-000000000002','accepted_hand_mt_2'),
      ('8e100000-0000-0000-0000-000000000003','accepted_hand_mt_3'),
      ('8e100000-0000-0000-0000-000000000004','accepted_hand_mt_4')
  $setup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$setup$
    INSERT INTO public.profiles(id,username,display_name) VALUES
      ('8e100000-0000-0000-0000-000000000001','accepted_hand_mt_1','Accepted Hand MT One'),
      ('8e100000-0000-0000-0000-000000000002','accepted_hand_mt_2','Accepted Hand MT Two'),
      ('8e100000-0000-0000-0000-000000000003','accepted_hand_mt_3','Accepted Hand MT Three'),
      ('8e100000-0000-0000-0000-000000000004','accepted_hand_mt_4','Accepted Hand MT Four')
  $setup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$setup$
    INSERT INTO public.tournaments
    SELECT (jsonb_populate_record(NULL::public.tournaments,
      to_jsonb(t)||jsonb_build_object(
        'id','8e000000-0000-0000-0000-000000000001',
        'name','Accepted Hand Multitable Concurrency Probe',
        'status','RUNNING','ended_at',NULL,'updated_at',now(),
        'current_players',4,'max_players',9,
        'prize_pool',40,'guaranteed_prize',0,
        'prize_pool_finalized',false,'bounty_pool',0,'bounty_pool_paid',0,
        'is_bounty',false,'is_pko',false,'is_mystery_bounty',false,
        'is_rebuy',false,'is_reentry',false,'add_on_available',false,
        'rebuy_levels',0,'late_reg_levels',0,'current_level',1))).*
      FROM public.tournaments t
     WHERE t.id='30000000-0000-0000-0000-000000000001'::uuid
  $setup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$setup$
    INSERT INTO public.tables
      (id,name,tournament_id,status,lifecycle,current_players,game_type,club_id)
    VALUES
      ('8e200000-0000-0000-0000-000000000001',
       'Accepted Hand Multitable One',
       '8e000000-0000-0000-0000-000000000001','running','live',2,
       'tournament','20000000-0000-0000-0000-000000000001'),
      ('8e200000-0000-0000-0000-000000000002',
       'Accepted Hand Multitable Two',
       '8e000000-0000-0000-0000-000000000001','running','live',2,
       'tournament','20000000-0000-0000-0000-000000000001')
  $setup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$setup$
    INSERT INTO public.tournament_players
    SELECT (jsonb_populate_record(NULL::public.tournament_players,
      to_jsonb(tp)||jsonb_build_object(
        'id',fixture.id,'tournament_id','8e000000-0000-0000-0000-000000000001',
        'user_id',fixture.user_id,'username',fixture.username,
        'chips',10,'status','playing','position',NULL,'prize',0,
        'eliminated_at',NULL,'elimination_sequence',NULL,'rebuy_prompt_until',NULL,
        'table_id',fixture.table_id,'seat_number',fixture.seat_number))).*
      FROM public.tournament_players tp
      CROSS JOIN (VALUES
        ('8e300000-0000-0000-0000-000000000001'::uuid,
         '8e100000-0000-0000-0000-000000000001'::uuid,'Accepted Hand MT One',
         '8e200000-0000-0000-0000-000000000001'::uuid,1),
        ('8e300000-0000-0000-0000-000000000002'::uuid,
         '8e100000-0000-0000-0000-000000000002'::uuid,'Accepted Hand MT Two',
         '8e200000-0000-0000-0000-000000000001'::uuid,2),
        ('8e300000-0000-0000-0000-000000000003'::uuid,
         '8e100000-0000-0000-0000-000000000003'::uuid,'Accepted Hand MT Three',
         '8e200000-0000-0000-0000-000000000002'::uuid,1),
        ('8e300000-0000-0000-0000-000000000004'::uuid,
         '8e100000-0000-0000-0000-000000000004'::uuid,'Accepted Hand MT Four',
         '8e200000-0000-0000-0000-000000000002'::uuid,2)
      ) AS fixture(id,user_id,username,table_id,seat_number)
     WHERE tp.tournament_id='30000000-0000-0000-0000-000000000001'::uuid
       AND tp.user_id='10000000-0000-0000-0000-000000000001'::uuid
  $setup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$setup$
    INSERT INTO public.table_seats
      (id,table_id,seat_number,user_id,stack,status,left_at,joined_at,
       leave_pending,is_sitting_out,is_away,club_id,
       time_bank_uses_remaining,time_bank_remaining)
    VALUES
      ('8e500000-0000-0000-0000-000000000001',
       '8e200000-0000-0000-0000-000000000001',1,
       '8e100000-0000-0000-0000-000000000001',10,'active',NULL,
       '2026-09-08 18:00:00+00',false,false,false,
       '20000000-0000-0000-0000-000000000001',4,30),
      ('8e500000-0000-0000-0000-000000000002',
       '8e200000-0000-0000-0000-000000000001',2,
       '8e100000-0000-0000-0000-000000000002',10,'active',NULL,
       '2026-09-08 18:00:01+00',false,false,false,
       '20000000-0000-0000-0000-000000000001',4,30),
      ('8e500000-0000-0000-0000-000000000003',
       '8e200000-0000-0000-0000-000000000002',1,
       '8e100000-0000-0000-0000-000000000003',10,'active',NULL,
       '2026-09-08 18:00:02+00',false,false,false,
       '20000000-0000-0000-0000-000000000001',4,30),
      ('8e500000-0000-0000-0000-000000000004',
       '8e200000-0000-0000-0000-000000000002',2,
       '8e100000-0000-0000-0000-000000000004',10,'active',NULL,
       '2026-09-08 18:00:03+00',false,false,false,
       '20000000-0000-0000-0000-000000000001',4,30)
  $setup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup',$setup$
    INSERT INTO public.engine_tournament_leases(
      tournament_id,instance_id,engine_version,acquired_at,heartbeat_at,
      lease_generation,protocol_version)
    VALUES (
      '8e000000-0000-0000-0000-000000000001',
      'accepted-hand-multitable-probe','probe',
      clock_timestamp(),clock_timestamp(),
      '8e600000-0000-0000-0000-000000000001',2)
  $setup$);
  PERFORM public.dblink_exec('accepted_hand_mt_setup','COMMIT');
  PERFORM public.dblink_disconnect('accepted_hand_mt_setup');

  PERFORM public.dblink_connect(
    'accepted_hand_mt_gate',v_conn||' application_name=accepted_hand_mt_gate');
  PERFORM public.dblink_connect(
    'accepted_hand_mt_one',v_conn||' application_name=accepted_hand_mt_one');
  PERFORM public.dblink_connect(
    'accepted_hand_mt_two',v_conn||' application_name=accepted_hand_mt_two');
  PERFORM public.dblink_exec('accepted_hand_mt_one',
    'SET statement_timeout=''10s''; SET deadlock_timeout=''100ms''');
  PERFORM public.dblink_exec('accepted_hand_mt_two',
    'SET statement_timeout=''10s''; SET deadlock_timeout=''100ms''');

  -- Own all four roster rows. Each hand reaches and waits on its own pair only
  -- after it has acquired the tournament lease and tournament FOR SHARE lock.
  PERFORM public.dblink_exec('accepted_hand_mt_gate','BEGIN');
  PERFORM public.dblink_exec(
    'accepted_hand_mt_gate','SET LOCAL session_replication_role=replica');
  PERFORM public.dblink_exec('accepted_hand_mt_gate',$gate$
    UPDATE public.tournament_players
       SET chips=chips
     WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid
  $gate$);

  PERFORM public.dblink_send_query('accepted_hand_mt_one',$hand_one$
    SELECT public.fn_ca_commit_hand_settlement(
      '8e200000-0000-0000-0000-000000000001',8900101,
      '[
        {"user_id":"8e100000-0000-0000-0000-000000000001","stack_before":10,"stack":10},
        {"user_id":"8e100000-0000-0000-0000-000000000002","stack_before":10,"stack":10}
      ]'::jsonb,
      0,0,'accepted-hand-multitable-one',0,
      '{
        "id":"8e400000-0000-0000-0000-000000000001",
        "table_id":"8e200000-0000-0000-0000-000000000001",
        "tournament_id":"8e000000-0000-0000-0000-000000000001",
        "hand_number":8900101,"game_variant":"nlh",
        "small_blind":1,"big_blind":2,"pot_size":0,
        "rake_amount":0,"bbj_amount":0,
        "players":[
          {"user_id":"8e100000-0000-0000-0000-000000000001","stack":10},
          {"user_id":"8e100000-0000-0000-0000-000000000002","stack":10}
        ],
        "actions":[],"winners":[],
        "_accepted_post_commit_facts":{
          "contributions":{
            "8e100000-0000-0000-0000-000000000001":0,
            "8e100000-0000-0000-0000-000000000002":0
          },"returned_uncalled":{},"insurance":[]
        }
      }'::jsonb,
      '[]'::jsonb,'accepted-hand-multitable-probe',
      '8e600000-0000-0000-0000-000000000001',
      '{
        "version":"1",
        "time_banks":[
          {"user_id":"8e100000-0000-0000-0000-000000000001","uses_remaining":4,"seconds_remaining":29},
          {"user_id":"8e100000-0000-0000-0000-000000000002","uses_remaining":4,"seconds_remaining":28}
        ],
        "promo_playthrough":[],"insurance":[],
        "pending_addons":null,"rake":null,"bbj_contribution":null
      }'::jsonb) AS result
  $hand_one$);
  PERFORM public.dblink_send_query('accepted_hand_mt_two',$hand_two$
    SELECT public.fn_ca_commit_hand_settlement(
      '8e200000-0000-0000-0000-000000000002',8900102,
      '[
        {"user_id":"8e100000-0000-0000-0000-000000000003","stack_before":10,"stack":10},
        {"user_id":"8e100000-0000-0000-0000-000000000004","stack_before":10,"stack":10}
      ]'::jsonb,
      0,0,'accepted-hand-multitable-two',0,
      '{
        "id":"8e400000-0000-0000-0000-000000000002",
        "table_id":"8e200000-0000-0000-0000-000000000002",
        "tournament_id":"8e000000-0000-0000-0000-000000000001",
        "hand_number":8900102,"game_variant":"nlh",
        "small_blind":1,"big_blind":2,"pot_size":0,
        "rake_amount":0,"bbj_amount":0,
        "players":[
          {"user_id":"8e100000-0000-0000-0000-000000000003","stack":10},
          {"user_id":"8e100000-0000-0000-0000-000000000004","stack":10}
        ],
        "actions":[],"winners":[],
        "_accepted_post_commit_facts":{
          "contributions":{
            "8e100000-0000-0000-0000-000000000003":0,
            "8e100000-0000-0000-0000-000000000004":0
          },"returned_uncalled":{},"insurance":[]
        }
      }'::jsonb,
      '[]'::jsonb,'accepted-hand-multitable-probe',
      '8e600000-0000-0000-0000-000000000001',
      '{
        "version":"1",
        "time_banks":[
          {"user_id":"8e100000-0000-0000-0000-000000000003","uses_remaining":4,"seconds_remaining":27},
          {"user_id":"8e100000-0000-0000-0000-000000000004","uses_remaining":4,"seconds_remaining":26}
        ],
        "promo_playthrough":[],"insurance":[],
        "pending_addons":null,"rake":null,"bbj_contribution":null
      }'::jsonb) AS result
  $hand_two$);

  FOR v_count IN 1..100 LOOP
    SELECT count(*)::integer INTO v_waiters
      FROM pg_stat_activity a
     WHERE a.datname=current_database()
       AND a.application_name IN ('accepted_hand_mt_one','accepted_hand_mt_two')
       AND a.wait_event_type='Lock';
    EXIT WHEN v_waiters=2;
    PERFORM pg_sleep(0.02);
  END LOOP;
  IF v_waiters<>2
     OR public.dblink_is_busy('accepted_hand_mt_one')<>1
     OR public.dblink_is_busy('accepted_hand_mt_two')<>1 THEN
    RAISE EXCEPTION
      'FAIL both accepted hands did not reach the roster gate after parent-share acquisition: lock waiters %',
      v_waiters;
  END IF;

  -- Both already retain the same parent SHARE lock. Releasing their disjoint
  -- roster pairs would deadlock immediately if either core tried to upgrade
  -- that parent to UPDATE.
  PERFORM public.dblink_exec('accepted_hand_mt_gate','COMMIT');
  BEGIN
    SELECT result INTO v_result_one
      FROM public.dblink_get_result('accepted_hand_mt_one') AS r(result jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error_one=MESSAGE_TEXT,v_state_one=RETURNED_SQLSTATE;
  END;
  BEGIN
    SELECT result INTO v_result_two
      FROM public.dblink_get_result('accepted_hand_mt_two') AS r(result jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error_two=MESSAGE_TEXT,v_state_two=RETURNED_SQLSTATE;
  END;
  IF v_error_one IS NOT NULL OR v_error_two IS NOT NULL
     OR COALESCE((v_result_one->>'success')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result_one->>'atomic_hand_commit')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result_one->>'post_commit_obligations')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result_one->>'replay')::boolean,false) IS TRUE
     OR COALESCE((v_result_two->>'success')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result_two->>'atomic_hand_commit')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result_two->>'post_commit_obligations')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result_two->>'replay')::boolean,false) IS TRUE THEN
    RAISE EXCEPTION
      'FAIL concurrent accepted hands did not both commit: one=% state=% error=%; two=% state=% error=%',
      v_result_one,v_state_one,v_error_one,v_result_two,v_state_two,v_error_two;
  END IF;

  PERFORM public.dblink_disconnect('accepted_hand_mt_one');
  PERFORM public.dblink_disconnect('accepted_hand_mt_two');
  PERFORM public.dblink_disconnect('accepted_hand_mt_gate');

  PERFORM public.dblink_connect('accepted_hand_mt_verify',v_conn);
  SELECT total INTO v_count
    FROM public.dblink('accepted_hand_mt_verify',$verify$
      SELECT
        (SELECT count(*) FROM public.hand_history
          WHERE id IN (
            '8e400000-0000-0000-0000-000000000001'::uuid,
            '8e400000-0000-0000-0000-000000000002'::uuid))+
        (SELECT count(*) FROM public.hand_atomic_commits
          WHERE table_id IN (
            '8e200000-0000-0000-0000-000000000001'::uuid,
            '8e200000-0000-0000-0000-000000000002'::uuid)
            AND post_commit_payload_hash IS NOT NULL)+
        (SELECT count(*) FROM public.hand_projection_outbox
          WHERE hand_id IN (
            '8e400000-0000-0000-0000-000000000001'::uuid,
            '8e400000-0000-0000-0000-000000000002'::uuid))+
        (SELECT count(*) FROM public.settlement_idempotency_keys
          WHERE table_id IN (
            '8e200000-0000-0000-0000-000000000001'::uuid,
            '8e200000-0000-0000-0000-000000000002'::uuid)
            AND status='succeeded')+
        (SELECT count(*) FROM public.ca_settlements
          WHERE table_id IN (
            '8e200000-0000-0000-0000-000000000001'::uuid,
            '8e200000-0000-0000-0000-000000000002'::uuid)
            AND state='final')+
        (SELECT count(*) FROM public.table_seats
          WHERE table_id IN (
            '8e200000-0000-0000-0000-000000000001'::uuid,
            '8e200000-0000-0000-0000-000000000002'::uuid)
            AND left_at IS NULL AND status='active' AND stack=10)+
        (SELECT count(*) FROM public.tournament_players
          WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid
            AND status='playing' AND chips=10) AS total
    $verify$) AS proof(total integer);
  -- 2 history + 2 atomic + 2 outbox + 2 idempotency + 2 settlements
  -- + 4 seats + 4 roster rows = 18 exact committed facts.
  IF v_count<>18 THEN
    RAISE EXCEPTION
      'FAIL concurrent accepted-hand receipts did not preserve all 18 exact facts: %',
      v_count;
  END IF;

  -- Committed cleanup is mandatory because the final PASS sentinel is an
  -- exception. Do it before raising the sentinel, then independently prove the
  -- fixture roots are gone.
  PERFORM public.dblink_exec('accepted_hand_mt_verify','BEGIN');
  PERFORM public.dblink_exec(
    'accepted_hand_mt_verify','SET LOCAL session_replication_role=replica');
  PERFORM public.dblink_exec('accepted_hand_mt_verify',$cleanup$
    DELETE FROM public.daily_challenge_event_outbox
     WHERE event_key IN (
       'hand:8e400000-0000-0000-0000-000000000001',
       'hand:8e400000-0000-0000-0000-000000000002');
    DELETE FROM public.bomb_pot_award_units
     WHERE hand_history_id IN (
       '8e400000-0000-0000-0000-000000000001'::uuid,
       '8e400000-0000-0000-0000-000000000002'::uuid);
    DELETE FROM public.hand_projection_outbox
     WHERE hand_id IN (
       '8e400000-0000-0000-0000-000000000001'::uuid,
       '8e400000-0000-0000-0000-000000000002'::uuid);
    DELETE FROM public.hand_atomic_commits
     WHERE table_id IN (
       '8e200000-0000-0000-0000-000000000001'::uuid,
       '8e200000-0000-0000-0000-000000000002'::uuid);
    DELETE FROM public.hand_history
     WHERE id IN (
       '8e400000-0000-0000-0000-000000000001'::uuid,
       '8e400000-0000-0000-0000-000000000002'::uuid);
    DELETE FROM public.ca_seat_stack_rebases
     WHERE table_id IN (
       '8e200000-0000-0000-0000-000000000001'::uuid,
       '8e200000-0000-0000-0000-000000000002'::uuid);
    DELETE FROM public.settlement_idempotency_keys
     WHERE table_id IN (
       '8e200000-0000-0000-0000-000000000001'::uuid,
       '8e200000-0000-0000-0000-000000000002'::uuid);
    DELETE FROM public.ca_settlements
     WHERE table_id IN (
       '8e200000-0000-0000-0000-000000000001'::uuid,
       '8e200000-0000-0000-0000-000000000002'::uuid);
    DELETE FROM public.tournament_manager_wakes
     WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid;
    DELETE FROM public.tournament_knockout_candidates
     WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid;
    DELETE FROM public.tournament_seat_exit_authorizations
     WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid;
    DELETE FROM public.table_seats
     WHERE table_id IN (
       '8e200000-0000-0000-0000-000000000001'::uuid,
       '8e200000-0000-0000-0000-000000000002'::uuid);
    DELETE FROM public.engine_tournament_leases
     WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid;
    DELETE FROM public.tournament_players
     WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid;
    DELETE FROM public.tables
     WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid;
    DELETE FROM public.tournaments
     WHERE id='8e000000-0000-0000-0000-000000000001'::uuid;
    DELETE FROM public.profiles
     WHERE id BETWEEN
       '8e100000-0000-0000-0000-000000000001'::uuid AND
       '8e100000-0000-0000-0000-000000000004'::uuid;
    DELETE FROM public.users
     WHERE id BETWEEN
       '8e100000-0000-0000-0000-000000000001'::uuid AND
       '8e100000-0000-0000-0000-000000000004'::uuid;
    DELETE FROM auth.users
     WHERE id BETWEEN
       '8e100000-0000-0000-0000-000000000001'::uuid AND
       '8e100000-0000-0000-0000-000000000004'::uuid
  $cleanup$);
  PERFORM public.dblink_exec('accepted_hand_mt_verify','COMMIT');
  SELECT residue INTO v_count
    FROM public.dblink('accepted_hand_mt_verify',$verify$
      SELECT
        (SELECT count(*) FROM public.tournaments
          WHERE id='8e000000-0000-0000-0000-000000000001'::uuid)+
        (SELECT count(*) FROM public.tables
          WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid)+
        (SELECT count(*) FROM public.tournament_players
          WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid)+
        (SELECT count(*) FROM public.hand_history
          WHERE id IN (
            '8e400000-0000-0000-0000-000000000001'::uuid,
            '8e400000-0000-0000-0000-000000000002'::uuid)) AS residue
    $verify$) AS proof(residue integer);
  IF v_count<>0 THEN
    RAISE EXCEPTION 'FAIL accepted-hand multitable fixture cleanup left % root row(s)',v_count;
  END IF;
  PERFORM public.dblink_disconnect('accepted_hand_mt_verify');

  RAISE EXCEPTION
    'AUDIT_TEST_PASS: two protocol-2 hands at different tables acquired the same MTT parent SHARE lock, waited together behind disjoint roster rows, and both committed all 18 exact facts after release without a parent-lock upgrade deadlock; fixture removed';
EXCEPTION WHEN OTHERS THEN
  -- Best-effort teardown preserves the original assertion or PASS sentinel.
  BEGIN PERFORM public.dblink_cancel_query('accepted_hand_mt_one');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM public.dblink_cancel_query('accepted_hand_mt_two');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM public.dblink_disconnect('accepted_hand_mt_one');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM public.dblink_disconnect('accepted_hand_mt_two');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM public.dblink_exec('accepted_hand_mt_gate','ROLLBACK');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM public.dblink_disconnect('accepted_hand_mt_gate');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM public.dblink_disconnect('accepted_hand_mt_setup');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM public.dblink_disconnect('accepted_hand_mt_verify');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN
    PERFORM public.dblink_connect('accepted_hand_mt_cleanup',v_conn);
    PERFORM public.dblink_exec('accepted_hand_mt_cleanup','BEGIN');
    PERFORM public.dblink_exec(
      'accepted_hand_mt_cleanup','SET LOCAL session_replication_role=replica');
    PERFORM public.dblink_exec('accepted_hand_mt_cleanup',$cleanup$
      DELETE FROM public.daily_challenge_event_outbox
       WHERE event_key IN (
         'hand:8e400000-0000-0000-0000-000000000001',
         'hand:8e400000-0000-0000-0000-000000000002');
      DELETE FROM public.bomb_pot_award_units
       WHERE hand_history_id IN (
         '8e400000-0000-0000-0000-000000000001'::uuid,
         '8e400000-0000-0000-0000-000000000002'::uuid);
      DELETE FROM public.hand_projection_outbox
       WHERE hand_id IN (
         '8e400000-0000-0000-0000-000000000001'::uuid,
         '8e400000-0000-0000-0000-000000000002'::uuid);
      DELETE FROM public.hand_atomic_commits
       WHERE table_id IN (
         '8e200000-0000-0000-0000-000000000001'::uuid,
         '8e200000-0000-0000-0000-000000000002'::uuid);
      DELETE FROM public.hand_history
       WHERE id IN (
         '8e400000-0000-0000-0000-000000000001'::uuid,
         '8e400000-0000-0000-0000-000000000002'::uuid);
      DELETE FROM public.ca_seat_stack_rebases
       WHERE table_id IN (
         '8e200000-0000-0000-0000-000000000001'::uuid,
         '8e200000-0000-0000-0000-000000000002'::uuid);
      DELETE FROM public.settlement_idempotency_keys
       WHERE table_id IN (
         '8e200000-0000-0000-0000-000000000001'::uuid,
         '8e200000-0000-0000-0000-000000000002'::uuid);
      DELETE FROM public.ca_settlements
       WHERE table_id IN (
         '8e200000-0000-0000-0000-000000000001'::uuid,
         '8e200000-0000-0000-0000-000000000002'::uuid);
      DELETE FROM public.tournament_manager_wakes
       WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid;
      DELETE FROM public.tournament_knockout_candidates
       WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid;
      DELETE FROM public.tournament_seat_exit_authorizations
       WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid;
      DELETE FROM public.table_seats
       WHERE table_id IN (
         '8e200000-0000-0000-0000-000000000001'::uuid,
         '8e200000-0000-0000-0000-000000000002'::uuid);
      DELETE FROM public.engine_tournament_leases
       WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid;
      DELETE FROM public.tournament_players
       WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid;
      DELETE FROM public.tables
       WHERE tournament_id='8e000000-0000-0000-0000-000000000001'::uuid;
      DELETE FROM public.tournaments
       WHERE id='8e000000-0000-0000-0000-000000000001'::uuid;
      DELETE FROM public.profiles
       WHERE id BETWEEN
         '8e100000-0000-0000-0000-000000000001'::uuid AND
         '8e100000-0000-0000-0000-000000000004'::uuid;
      DELETE FROM public.users
       WHERE id BETWEEN
         '8e100000-0000-0000-0000-000000000001'::uuid AND
         '8e100000-0000-0000-0000-000000000004'::uuid;
      DELETE FROM auth.users
       WHERE id BETWEEN
         '8e100000-0000-0000-0000-000000000001'::uuid AND
         '8e100000-0000-0000-0000-000000000004'::uuid
    $cleanup$);
    PERFORM public.dblink_exec('accepted_hand_mt_cleanup','COMMIT');
    PERFORM public.dblink_disconnect('accepted_hand_mt_cleanup');
  EXCEPTION WHEN OTHERS THEN
    BEGIN PERFORM public.dblink_disconnect('accepted_hand_mt_cleanup');
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END;
  RAISE;
END;
$accepted_hand_multitable_concurrency$;
