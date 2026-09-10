\set ON_ERROR_STOP on

SELECT set_config('test.engine','true',false);

INSERT INTO public.tournaments(
  id,status,variant,tournament_type,game_type,max_players,table_size,starting_chips
) VALUES
  ('10000000-0000-4000-8000-000000000001','RUNNING','freezeout','SPIN','nlh',3,3,300),
  ('10000000-0000-4000-8000-000000000002','RUNNING','spin','MTT','nlh',3,3,300),
  ('10000000-0000-4000-8000-000000000003','RUNNING','freezeout','SNG','nlh',2,2,300);

INSERT INTO public.tables(id,tournament_id,status,max_players,is_deleted) VALUES
  ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','running',3,true),
  ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','running',3,false),
  ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','running',3,false),
  ('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000003','running',2,false);

INSERT INTO public.tournament_players(
  id,tournament_id,user_id,status,chips
) VALUES
  ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','registered',0),
  ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000002','playing',175),
  ('30000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000003','playing',175);

DO $initial_and_replay$
DECLARE first_receipt jsonb; replay_receipt jsonb;
BEGIN
  first_receipt:=public.fn_assign_tournament_player_seat_atomic(
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',3);
  IF COALESCE((first_receipt->>'ok')::boolean,false) IS NOT TRUE
     OR first_receipt->>'table_id' IS DISTINCT FROM
          '20000000-0000-4000-8000-000000000002'
     OR (first_receipt->>'seat_number')::integer IS DISTINCT FROM 1
     OR (first_receipt->>'stack')::numeric IS DISTINCT FROM 300
     OR COALESCE((first_receipt->>'replayed')::boolean,true) THEN
    RAISE EXCEPTION 'database did not replace the deleted caller hint: %',first_receipt;
  END IF;
  replay_receipt:=public.fn_assign_tournament_player_seat_atomic(
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',3);
  IF COALESCE((replay_receipt->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((replay_receipt->>'replayed')::boolean,false) IS NOT TRUE
     OR replay_receipt->>'seat_id' IS DISTINCT FROM first_receipt->>'seat_id'
     OR replay_receipt->>'table_id' IS DISTINCT FROM first_receipt->>'table_id'
     OR replay_receipt->>'seat_number' IS DISTINCT FROM
          first_receipt->>'seat_number'
     OR replay_receipt->>'stack' IS DISTINCT FROM first_receipt->>'stack' THEN
    RAISE EXCEPTION 'response-loss retry did not replay the exact chair: %',replay_receipt;
  END IF;
END;
$initial_and_replay$;

INSERT INTO public.table_seats(
  id,table_id,user_id,seat_number,stack,joined_at,left_at
) VALUES(
  '50000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-000000000002',1,175,
  clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute');

WITH payload AS (
  SELECT jsonb_build_object(
    'success',true,
    'table_id','20000000-0000-4000-8000-000000000003',
    'hand_id','60000000-0000-4000-8000-000000000002',
    'hand_number',1000002,
    'written',jsonb_build_object(
      '40000000-0000-4000-8000-000000000002',175)) AS result
)
INSERT INTO public.hand_atomic_commits(
  table_id,hand_number,hand_id,stack_result,committed_at,
  post_commit_completed_at,post_commit_result
)
SELECT '20000000-0000-4000-8000-000000000003',1000002,
       '60000000-0000-4000-8000-000000000002',result,
       clock_timestamp()-interval '90 seconds',clock_timestamp()-interval '80 seconds',
       '{"ok":true}'::jsonb
  FROM payload;

DO $played_spin_needs_both_journals$
BEGIN
  BEGIN
    PERFORM public.fn_assign_tournament_player_seat_atomic(
      '10000000-0000-4000-8000-000000000002',
      '40000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000003',1);
    RAISE EXCEPTION 'played Spin was seated from its hand journal alone';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS%' THEN
      RAISE;
    END IF;
  END;
END;
$played_spin_needs_both_journals$;

INSERT INTO public.settlement_idempotency_keys(
  table_id,hand_id,status,result,completed_at
)
SELECT h.table_id,h.hand_id,'succeeded',h.stack_result,
       clock_timestamp()-interval '85 seconds'
  FROM public.hand_atomic_commits h WHERE h.hand_number=1000002;

DO $played_spin_reseat$
DECLARE receipt jsonb;
BEGIN
  receipt:=public.fn_assign_tournament_player_seat_atomic(
    '10000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000003',1);
  IF COALESCE((receipt->>'ok')::boolean,false) IS NOT TRUE
     OR receipt->>'table_id' IS DISTINCT FROM
          '20000000-0000-4000-8000-000000000003'
     OR (receipt->>'seat_number')::integer IS DISTINCT FROM 1
     OR (receipt->>'stack')::numeric IS DISTINCT FROM 175
     OR COALESCE((receipt->>'replayed')::boolean,true) THEN
    RAISE EXCEPTION 'proved played Spin did not retain its exact stack: %',receipt;
  END IF;
END;
$played_spin_reseat$;

DO $seat_first_guards$
BEGIN
  BEGIN
    INSERT INTO public.table_seats(
      table_id,user_id,seat_number,stack,joined_at,left_at
    ) VALUES(
      '20000000-0000-4000-8000-000000000002',
      '40000000-0000-4000-8000-000000000099',2,175,clock_timestamp(),NULL);
    RAISE EXCEPTION 'tournament_type SPIN bypassed its starting-stack guard';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.fn_assign_tournament_player_seat_atomic(
      '10000000-0000-4000-8000-000000000003',
      '40000000-0000-4000-8000-000000000003',
      '20000000-0000-4000-8000-000000000004',1);
    RAISE EXCEPTION 'unproved changed heads-up stack was seated';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS%' THEN RAISE; END IF;
  END;
END;
$seat_first_guards$;

DO $acl_proof$
BEGIN
  IF has_function_privilege(
       'authenticated',
       'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'tournament seat authority ACL widened';
  END IF;
END;
$acl_proof$;

SELECT 'POSTGRESQL_17_TOURNAMENT_RESEATING_PASS';
