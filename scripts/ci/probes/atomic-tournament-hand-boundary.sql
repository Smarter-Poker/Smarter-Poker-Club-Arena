-- Run as postgres only on a disposable clone after the complete stage-one
-- migration replay. The final AUDIT_TEST_PASS exception intentionally rolls
-- back the fixture, temporary fault and every accepted-hand evidence row.
BEGIN;

DO $fixture_guard$
BEGIN
  IF current_user <> 'postgres'
     OR NOT EXISTS (
       SELECT 1 FROM public.tournaments
        WHERE id='30000000-0000-0000-0000-000000000001'::uuid)
     OR to_regprocedure(
       'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)')
          IS NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)')
          IS NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)')
          IS NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)')
          IS NULL
     OR to_regclass('public.hand_atomic_commits') IS NULL
     OR to_regclass('public.tournament_knockout_candidates') IS NULL
     OR to_regclass('public.tournament_manager_wakes') IS NULL THEN
    RAISE EXCEPTION
      'atomic tournament hand boundary probe requires the disposable stage-one rehearsal database';
  END IF;
END;
$fixture_guard$;

SET LOCAL session_replication_role = replica;

INSERT INTO public.profiles(id,username,display_name)
VALUES (
  '10000000-0000-0000-0000-000000000002',
  'atomic_hand_boundary_2','Atomic Hand Boundary Two');

INSERT INTO public.tournaments
SELECT (jsonb_populate_record(NULL::public.tournaments,
  to_jsonb(t) || jsonb_build_object(
    'id','86000000-0000-0000-0000-000000000001',
    'name','Atomic Tournament Hand Boundary Probe',
    'status','RUNNING','ended_at',NULL,'updated_at',now(),
    'current_players',2,'max_players',2,
    'prize_pool',20,'guaranteed_prize',0,
    'prize_pool_finalized',false,'bounty_pool',0,'bounty_pool_paid',0,
    'starting_chips',10,
    'is_bounty',false,'is_pko',false,'is_mystery_bounty',false,
    'is_rebuy',true,'is_reentry',true,'add_on_available',false,
    'max_rebuys',5,'max_reentries',5,
    'rebuy_cost',10,'rebuy_chips',10,
    'rebuy_levels',5,'late_reg_levels',5,'current_level',1
  ))).*
  FROM public.tournaments t
 WHERE t.id='30000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tables
  (id,name,tournament_id,status,lifecycle,current_players,game_type,club_id)
VALUES
  ('86100000-0000-0000-0000-000000000001',
   'Atomic Tournament Hand Boundary Table',
   '86000000-0000-0000-0000-000000000001',
   'running','live',2,'tournament',
   '20000000-0000-0000-0000-000000000001');

INSERT INTO public.tournament_players
SELECT (jsonb_populate_record(NULL::public.tournament_players,
  to_jsonb(tp) || jsonb_build_object(
    'id','86200000-0000-0000-0000-000000000001',
    'tournament_id','86000000-0000-0000-0000-000000000001',
    'user_id','10000000-0000-0000-0000-000000000001',
    'chips',10,'status','playing','position',NULL,'prize',0,
    'eliminated_at',NULL,'elimination_sequence',NULL,
    'rebuy_prompt_until',NULL,
    'table_id','86100000-0000-0000-0000-000000000001','seat_number',1
  ))).*
  FROM public.tournament_players tp
 WHERE tp.tournament_id='30000000-0000-0000-0000-000000000001'::uuid
   AND tp.user_id='10000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tournament_escrow(
  tournament_id,gross_in,fee_entries_in,satellite_fee_in,bounty_in,
  overlay_in,satellite_in,prize_out,bounty_out,fee_out,refund_prize,
  refund_bounty,refund_fee,reserve_out,reserve_in,prize_balance,
  bounty_balance,fee_balance,opened_from,opened_at,updated_at,enforced)
VALUES(
  '86000000-0000-0000-0000-000000000001',
  20,0,0,0,0,0,0,0,0,0,0,0,0,0,20,0,0,
  'atomic-hand-boundary-probe',now(),now(),true);

UPDATE public.club_members
   SET chip_balance=100
 WHERE club_id='20000000-0000-0000-0000-000000000001'::uuid
   AND user_id='10000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tournament_players
SELECT (jsonb_populate_record(NULL::public.tournament_players,
  to_jsonb(tp) || jsonb_build_object(
    'id','86200000-0000-0000-0000-000000000002',
    'tournament_id','86000000-0000-0000-0000-000000000001',
    'user_id','10000000-0000-0000-0000-000000000002',
    'chips',10,'status','playing','position',NULL,'prize',0,
    'eliminated_at',NULL,'elimination_sequence',NULL,
    'rebuy_prompt_until',NULL,
    'table_id','86100000-0000-0000-0000-000000000001','seat_number',2
  ))).*
  FROM public.tournament_players tp
 WHERE tp.tournament_id='30000000-0000-0000-0000-000000000001'::uuid
   AND tp.user_id='10000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.table_seats
  (id,table_id,seat_number,user_id,stack,status,left_at,joined_at,
   leave_pending,is_sitting_out,is_away,club_id,
   time_bank_uses_remaining,time_bank_remaining)
VALUES
  ('86300000-0000-0000-0000-000000000001',
   '86100000-0000-0000-0000-000000000001',1,
   '10000000-0000-0000-0000-000000000001',10,'active',NULL,
   '2026-09-08 12:00:00+00',false,false,false,
   '20000000-0000-0000-0000-000000000001',4,30),
  ('86300000-0000-0000-0000-000000000002',
   '86100000-0000-0000-0000-000000000001',2,
   '10000000-0000-0000-0000-000000000002',10,'active',NULL,
   '2026-09-08 12:00:01+00',false,false,false,
   '20000000-0000-0000-0000-000000000001',4,30);

INSERT INTO public.engine_tournament_leases(
  tournament_id,instance_id,engine_version,acquired_at,heartbeat_at,
  lease_generation,protocol_version)
VALUES (
  '86000000-0000-0000-0000-000000000001',
  'atomic-hand-boundary-probe','probe',
  clock_timestamp(),clock_timestamp(),
  '86500000-0000-0000-0000-000000000001',2);

SET LOCAL session_replication_role = origin;

-- Matching zeroes are data, never authority. Prove that a caller which forges
-- both historical halves still cannot release the seat without the private,
-- one-use accepted-hand capability. The outer exception rolls the forged
-- zeroes back before the real hand fixture begins.
DO $tokenless_zero_state_is_refused$
DECLARE
  v_refused boolean:=false;
BEGIN
  BEGIN
    UPDATE public.tournament_players
       SET chips=0
     WHERE tournament_id='86000000-0000-0000-0000-000000000001'::uuid
       AND user_id='10000000-0000-0000-0000-000000000001'::uuid;
    UPDATE public.table_seats
       SET stack=0
     WHERE id='86300000-0000-0000-0000-000000000001'::uuid;
    BEGIN
      UPDATE public.table_seats
         SET left_at=clock_timestamp(),status='left',leave_pending=false,
             is_sitting_out=false,is_away=false,sit_out_at=NULL,
             scheduled_leave_hands=NULL
       WHERE id='86300000-0000-0000-0000-000000000001'::uuid;
    EXCEPTION WHEN SQLSTATE '55000' THEN
      v_refused:=SQLERRM LIKE
        '%TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY%';
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'FAIL forged zero state bypassed tournament seat authority';
    END IF;
    RAISE EXCEPTION 'ROLLBACK_TOKENLESS_FORGE' USING ERRCODE='ZX903';
  EXCEPTION WHEN SQLSTATE 'ZX903' THEN
    NULL;
  END;

  IF NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.id='86300000-0000-0000-0000-000000000001'::uuid
          AND s.stack=10 AND s.left_at IS NULL AND s.status='active')
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id='86000000-0000-0000-0000-000000000001'::uuid
          AND tp.user_id='10000000-0000-0000-0000-000000000001'::uuid
          AND tp.chips=10 AND tp.status='playing') THEN
    RAISE EXCEPTION 'FAIL tokenless-forge rollback changed the hand fixture';
  END IF;
END;
$tokenless_zero_state_is_refused$;

CREATE FUNCTION pg_temp.atomic_hand_stacks()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $stacks$
  SELECT jsonb_build_array(
    jsonb_build_object(
      'user_id','10000000-0000-0000-0000-000000000001',
      'stack_before',10,'stack',0),
    jsonb_build_object(
      'user_id','10000000-0000-0000-0000-000000000002',
      'stack_before',10,'stack',20));
$stacks$;

CREATE FUNCTION pg_temp.atomic_hand_row()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $hand$
  SELECT jsonb_build_object(
    'id','86400000-0000-0000-0000-000000000001',
    'table_id','86100000-0000-0000-0000-000000000001',
    'tournament_id','86000000-0000-0000-0000-000000000001',
    'hand_number',8600001,
    'game_variant','nlh',
    'small_blind',1,
    'big_blind',2,
    'pot_size',20,
    'rake_amount',0,
    'bbj_amount',0,
    'players',jsonb_build_array(
      jsonb_build_object(
        'user_id','10000000-0000-0000-0000-000000000001','stack',0),
      jsonb_build_object(
        'user_id','10000000-0000-0000-0000-000000000002','stack',20)),
    'actions','[]'::jsonb,
    'winners',jsonb_build_array(
      jsonb_build_object(
        'user_id','10000000-0000-0000-0000-000000000002','amount',20)),
    '_accepted_post_commit_facts',jsonb_build_object(
      'contributions',jsonb_build_object(
        '10000000-0000-0000-0000-000000000001',10,
        '10000000-0000-0000-0000-000000000002',10),
      'returned_uncalled','{}'::jsonb,
      'insurance','[]'::jsonb));
$hand$;

CREATE FUNCTION pg_temp.atomic_hand_obligations()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $obligations$
  SELECT jsonb_build_object(
    'version','1',
    'time_banks',jsonb_build_array(
      jsonb_build_object(
        'user_id','10000000-0000-0000-0000-000000000001',
        'uses_remaining',3,'seconds_remaining',17),
      jsonb_build_object(
        'user_id','10000000-0000-0000-0000-000000000002',
        'uses_remaining',2,'seconds_remaining',19)),
    'promo_playthrough','[]'::jsonb,
    'insurance','[]'::jsonb,
    'pending_addons','null'::jsonb,
    'rake','null'::jsonb,
    'bbj_contribution','null'::jsonb);
$obligations$;

CREATE FUNCTION pg_temp.commit_atomic_hand()
RETURNS jsonb
LANGUAGE sql
VOLATILE
SET search_path TO 'public','pg_temp'
AS $commit$
  SELECT public.fn_ca_commit_hand_settlement(
    '86100000-0000-0000-0000-000000000001',
    8600001,
    pg_temp.atomic_hand_stacks(),
    0,0,'atomic-zero-seat',0,
    pg_temp.atomic_hand_row(),
    '[]'::jsonb,
    'atomic-hand-boundary-probe',
    '86500000-0000-0000-0000-000000000001',
    pg_temp.atomic_hand_obligations());
$commit$;

CREATE FUNCTION pg_temp.commit_no_bust_hand()
RETURNS jsonb
LANGUAGE sql
VOLATILE
SET search_path TO 'public','pg_temp'
AS $commit$
  SELECT public.fn_ca_commit_hand_settlement(
    '86100000-0000-0000-0000-000000000001',
    8600000,
    jsonb_build_array(
      jsonb_build_object(
        'user_id','10000000-0000-0000-0000-000000000001',
        'stack_before',10,'stack',10),
      jsonb_build_object(
        'user_id','10000000-0000-0000-0000-000000000002',
        'stack_before',10,'stack',10)),
    0,0,'atomic-no-zero-seat',0,
    jsonb_build_object(
      'id','86400000-0000-0000-0000-000000000000',
      'table_id','86100000-0000-0000-0000-000000000001',
      'tournament_id','86000000-0000-0000-0000-000000000001',
      'hand_number',8600000,
      'game_variant','nlh','small_blind',1,'big_blind',2,
      'pot_size',0,'rake_amount',0,'bbj_amount',0,
      'players',jsonb_build_array(
        jsonb_build_object(
          'user_id','10000000-0000-0000-0000-000000000001','stack',10),
        jsonb_build_object(
          'user_id','10000000-0000-0000-0000-000000000002','stack',10)),
      'actions','[]'::jsonb,'winners','[]'::jsonb,
      '_accepted_post_commit_facts',jsonb_build_object(
        'contributions',jsonb_build_object(
          '10000000-0000-0000-0000-000000000001',0,
          '10000000-0000-0000-0000-000000000002',0),
        'returned_uncalled','{}'::jsonb,
        'insurance','[]'::jsonb)),
    '[]'::jsonb,
    'atomic-hand-boundary-probe',
    '86500000-0000-0000-0000-000000000001',
    jsonb_build_object(
      'version','1',
      'time_banks',jsonb_build_array(
        jsonb_build_object(
          'user_id','10000000-0000-0000-0000-000000000001',
          'uses_remaining',4,'seconds_remaining',29),
        jsonb_build_object(
          'user_id','10000000-0000-0000-0000-000000000002',
          'uses_remaining',4,'seconds_remaining',28)),
      'promo_playthrough','[]'::jsonb,
      'insurance','[]'::jsonb,
      'pending_addons','null'::jsonb,
      'rake','null'::jsonb,
      'bbj_contribution','null'::jsonb));
$commit$;

DO $no_bust_control$
DECLARE
  v_result jsonb:=pg_temp.commit_no_bust_hand();
  v_replay jsonb;
BEGIN
  v_replay:=pg_temp.commit_no_bust_hand();
  IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result->>'atomic_hand_commit')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result->>'post_commit_obligations')::boolean,false)
          IS NOT TRUE
     OR (v_result->>'history_id')::uuid <>
          '86400000-0000-0000-0000-000000000000'::uuid
     OR (v_result->>'tournament_zero_stack_seat_count')::integer <> 0
     OR v_result->'tournament_zero_stack_seat_generations'
          IS DISTINCT FROM '[]'::jsonb
     OR v_result->'tournament_zero_stack_vacated_at'
          IS DISTINCT FROM 'null'::jsonb
     OR COALESCE((v_replay->>'replay')::boolean,false) IS NOT TRUE
     OR (v_replay - 'replay') IS DISTINCT FROM v_result
     OR (SELECT count(*) FROM public.table_seats s
          WHERE s.table_id='86100000-0000-0000-0000-000000000001'::uuid
            AND s.left_at IS NULL AND s.stack=10) <> 2
     OR NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.id='86300000-0000-0000-0000-000000000001'::uuid
          AND s.time_bank_uses_remaining=4 AND s.time_bank_remaining=29)
     OR NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.id='86300000-0000-0000-0000-000000000002'::uuid
          AND s.time_bank_uses_remaining=4 AND s.time_bank_remaining=28)
     OR EXISTS (
       SELECT 1 FROM public.tournament_knockout_candidates c
        WHERE c.tournament_id='86000000-0000-0000-0000-000000000001'::uuid)
     OR EXISTS (
       SELECT 1 FROM public.tournament_manager_wakes w
        WHERE w.tournament_id='86000000-0000-0000-0000-000000000001'::uuid
          AND w.reason='accepted_hand_bust')
     OR (SELECT count(*) FROM public.hand_history h
          WHERE h.id='86400000-0000-0000-0000-000000000000'::uuid
            AND h.hand_number=8600000) <> 1
     OR (SELECT count(*) FROM public.hand_atomic_commits c
          WHERE c.table_id='86100000-0000-0000-0000-000000000001'::uuid
            AND c.hand_number=8600000
            AND c.hand_id='86400000-0000-0000-0000-000000000000'::uuid) <> 1 THEN
    RAISE EXCEPTION
      'FAIL public protocol-2 control hand did not preserve exact empty zero-seat evidence and replay once: %, replay %',
      v_result,v_replay;
  END IF;
END;
$no_bust_control$;

CREATE FUNCTION pg_temp.atomic_hand_gameplay_state()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public','pg_temp'
AS $state$
  SELECT jsonb_build_object(
    'players',(SELECT jsonb_agg(to_jsonb(tp) ORDER BY tp.id)
                 FROM public.tournament_players tp
                WHERE tp.tournament_id=
                  '86000000-0000-0000-0000-000000000001'::uuid),
    'seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
               FROM public.table_seats s
              WHERE s.table_id=
                '86100000-0000-0000-0000-000000000001'::uuid),
    'table',(SELECT to_jsonb(tb) FROM public.tables tb
              WHERE tb.id='86100000-0000-0000-0000-000000000001'::uuid));
$state$;

CREATE FUNCTION pg_temp.reject_zero_stack_vacate()
RETURNS trigger
LANGUAGE plpgsql
AS $failure$
BEGIN
  IF NEW.id='86300000-0000-0000-0000-000000000001'::uuid
     AND OLD.left_at IS NULL AND NEW.left_at IS NOT NULL THEN
    RAISE EXCEPTION 'injected zero-stack seat vacate failure'
      USING ERRCODE='ZX902';
  END IF;
  RETURN NEW;
END;
$failure$;

CREATE TRIGGER zz_probe_reject_zero_stack_vacate
  BEFORE UPDATE OF left_at ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_zero_stack_vacate();

DO $rollback_probe$
DECLARE
  v_before jsonb := pg_temp.atomic_hand_gameplay_state();
  v_after jsonb;
  v_result jsonb;
BEGIN
  v_result := pg_temp.commit_atomic_hand();
  v_after := pg_temp.atomic_hand_gameplay_state();
  IF COALESCE((v_result->>'success')::boolean,true) IS NOT FALSE
     OR COALESCE((v_result->>'atomic_hand_commit')::boolean,true) IS NOT FALSE
     OR v_result->>'reason' <> 'rolled_back'
     OR v_result->>'error' NOT LIKE '%injected zero-stack seat vacate failure%'
     OR v_after IS DISTINCT FROM v_before
     OR EXISTS (
       SELECT 1 FROM public.hand_history h
        WHERE h.id='86400000-0000-0000-0000-000000000001'::uuid
           OR h.hand_number=8600001)
     OR EXISTS (
       SELECT 1 FROM public.tournament_knockout_candidates c
        WHERE c.tournament_id='86000000-0000-0000-0000-000000000001'::uuid)
     OR EXISTS (
       SELECT 1 FROM public.hand_atomic_commits c
        WHERE c.hand_number=8600001)
     OR EXISTS (
       SELECT 1 FROM public.hand_projection_outbox o
        WHERE o.hand_number=8600001)
     OR EXISTS (
       SELECT 1 FROM public.tournament_manager_wakes w
        WHERE w.tournament_id='86000000-0000-0000-0000-000000000001'::uuid
          AND w.reason='accepted_hand_bust') THEN
    RAISE EXCEPTION
      'FAIL public hand RPC did not roll every gameplay/history/candidate/receipt row back on the injected seat fault: %, state %',
      v_result,v_after;
  END IF;
END;
$rollback_probe$;

DROP TRIGGER zz_probe_reject_zero_stack_vacate ON public.table_seats;

-- The wake is emitted after the exact zero-seat capability is consumed but
-- before history/candidate/outbox/receipt completion. Force a later member of
-- the accepted-hand transaction to fail and prove the wake is not an orphaned
-- process signal: it rolls back with every earlier gameplay mutation.
CREATE FUNCTION pg_temp.reject_atomic_hand_outbox()
RETURNS trigger
LANGUAGE plpgsql
AS $failure$
BEGIN
  IF NEW.hand_number=8600001 THEN
    RAISE EXCEPTION 'injected late accepted-hand outbox failure'
      USING ERRCODE='ZX904';
  END IF;
  RETURN NEW;
END;
$failure$;

CREATE TRIGGER zz_probe_reject_atomic_hand_outbox
  BEFORE INSERT ON public.hand_projection_outbox
  FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_atomic_hand_outbox();

DO $late_rollback_probe$
DECLARE
  v_before jsonb:=pg_temp.atomic_hand_gameplay_state();
  v_result jsonb;
BEGIN
  v_result:=pg_temp.commit_atomic_hand();
  IF COALESCE((v_result->>'success')::boolean,true) IS NOT FALSE
     OR COALESCE((v_result->>'atomic_hand_commit')::boolean,true) IS NOT FALSE
     OR v_result->>'reason'<>'atomic_hand_rolled_back'
     OR v_result->>'error' NOT LIKE '%injected late accepted-hand outbox failure%'
     OR pg_temp.atomic_hand_gameplay_state() IS DISTINCT FROM v_before
     OR EXISTS (
       SELECT 1 FROM public.hand_history h
        WHERE h.id='86400000-0000-0000-0000-000000000001'::uuid
           OR h.hand_number=8600001)
     OR EXISTS (
       SELECT 1 FROM public.tournament_knockout_candidates c
        WHERE c.tournament_id='86000000-0000-0000-0000-000000000001'::uuid)
     OR EXISTS (
       SELECT 1 FROM public.hand_atomic_commits c
        WHERE c.hand_number=8600001)
     OR EXISTS (
       SELECT 1 FROM public.hand_projection_outbox o
        WHERE o.hand_number=8600001)
     OR EXISTS (
       SELECT 1 FROM public.tournament_manager_wakes w
        WHERE w.tournament_id='86000000-0000-0000-0000-000000000001'::uuid
          AND w.reason='accepted_hand_bust') THEN
    RAISE EXCEPTION
      'FAIL a late accepted-hand fault did not roll back its gameplay, history, candidate, outbox, receipt, and durable bust wake together: %',
      v_result;
  END IF;
END;
$late_rollback_probe$;

DROP TRIGGER zz_probe_reject_atomic_hand_outbox
  ON public.hand_projection_outbox;

DO $success_replay_probe$
DECLARE
  v_result jsonb;
  v_replay jsonb;
  v_after jsonb;
  v_vacated_at timestamptz;
  v_expected_generation jsonb:=jsonb_build_array(jsonb_build_object(
    'seat_id','86300000-0000-0000-0000-000000000001'::uuid,
    'user_id','10000000-0000-0000-0000-000000000001'::uuid,
    'seat_number',1,
    'joined_at','2026-09-08 12:00:00+00'::timestamptz));
BEGIN
  v_result := pg_temp.commit_atomic_hand();
  v_after := pg_temp.atomic_hand_gameplay_state();
  v_replay := pg_temp.commit_atomic_hand();
  v_vacated_at :=
    (v_result->>'tournament_zero_stack_vacated_at')::timestamptz;

  IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result->>'atomic_hand_commit')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result->>'post_commit_obligations')::boolean,false)
          IS NOT TRUE
     OR (v_result->>'history_id')::uuid <>
          '86400000-0000-0000-0000-000000000001'::uuid
     OR COALESCE((v_result->>'tournament_players_synced')::boolean,false)
          IS NOT TRUE
     OR COALESCE((v_result->>'tournament_zero_stack_seats_vacated')::boolean,false)
          IS NOT TRUE
     OR (v_result->>'tournament_player_count')::integer <> 2
     OR (v_result->>'tournament_zero_stack_seat_count')::integer <> 1
     OR v_result->'tournament_zero_stack_seat_ids' <>
          jsonb_build_array(
            '86300000-0000-0000-0000-000000000001'::uuid)
     OR v_result->'tournament_zero_stack_user_ids' <>
          jsonb_build_array(
            '10000000-0000-0000-0000-000000000001'::uuid)
     OR v_result->'tournament_zero_stack_seat_generations'
          IS DISTINCT FROM v_expected_generation
     OR v_vacated_at IS NULL
     OR COALESCE((v_replay->>'success')::boolean,false) IS NOT TRUE
     OR COALESCE((v_replay->>'atomic_hand_commit')::boolean,false) IS NOT TRUE
     OR COALESCE((v_replay->>'post_commit_obligations')::boolean,false)
          IS NOT TRUE
     OR COALESCE((v_replay->>'replay')::boolean,false) IS NOT TRUE
     OR (v_replay - 'replay') IS DISTINCT FROM v_result
     OR pg_temp.atomic_hand_gameplay_state() IS DISTINCT FROM v_after
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id='86000000-0000-0000-0000-000000000001'::uuid
          AND tp.user_id='10000000-0000-0000-0000-000000000001'::uuid
          AND tp.status::text='playing' AND tp.chips=0)
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id='86000000-0000-0000-0000-000000000001'::uuid
          AND tp.user_id='10000000-0000-0000-0000-000000000002'::uuid
          AND tp.status::text='playing' AND tp.chips=20)
     OR NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.id='86300000-0000-0000-0000-000000000001'::uuid
          AND s.user_id='10000000-0000-0000-0000-000000000001'::uuid
          AND s.seat_number=1
          AND s.joined_at='2026-09-08 12:00:00+00'::timestamptz
          AND s.stack=0 AND s.left_at=v_vacated_at AND s.status='left'
          AND s.time_bank_uses_remaining=3 AND s.time_bank_remaining=17
          AND COALESCE(s.leave_pending,false) IS FALSE
          AND COALESCE(s.is_sitting_out,false) IS FALSE
          AND COALESCE(s.is_away,false) IS FALSE)
     OR NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.id='86300000-0000-0000-0000-000000000002'::uuid
          AND s.user_id='10000000-0000-0000-0000-000000000002'::uuid
          AND s.stack=20 AND s.left_at IS NULL
          AND s.time_bank_uses_remaining=2 AND s.time_bank_remaining=19)
     OR (SELECT tb.current_players FROM public.tables tb
          WHERE tb.id='86100000-0000-0000-0000-000000000001'::uuid) <> 1
     OR (SELECT count(*) FROM public.hand_history h
          WHERE h.id='86400000-0000-0000-0000-000000000001'::uuid
            AND h.hand_number=8600001
            AND h.table_id='86100000-0000-0000-0000-000000000001'::uuid
            AND h.tournament_id='86000000-0000-0000-0000-000000000001'::uuid) <> 1
     OR (SELECT count(*) FROM public.tournament_knockout_candidates c
          WHERE c.tournament_id='86000000-0000-0000-0000-000000000001'::uuid
            AND c.eliminated_user_id='10000000-0000-0000-0000-000000000001'::uuid
            AND c.table_id='86100000-0000-0000-0000-000000000001'::uuid
            AND c.seat_id='86300000-0000-0000-0000-000000000001'::uuid
            AND c.seat_joined_at='2026-09-08 12:00:00+00'::timestamptz
            AND c.hand_id='86400000-0000-0000-0000-000000000001'::uuid
            AND c.hand_number=8600001
            AND c.stack_before=10 AND c.stack_after=0) <> 1
     OR (SELECT count(*) FROM public.tournament_knockout_candidates c
          WHERE c.tournament_id=
            '86000000-0000-0000-0000-000000000001'::uuid) <> 1
     OR (SELECT count(*) FROM public.hand_atomic_commits c
          WHERE c.table_id='86100000-0000-0000-0000-000000000001'::uuid
            AND c.hand_number=8600001
            AND c.hand_id='86400000-0000-0000-0000-000000000001'::uuid
            AND c.stack_result->'tournament_zero_stack_seat_generations'
                  =v_expected_generation
            AND (c.stack_result->>'tournament_zero_stack_vacated_at')::timestamptz
                  =v_vacated_at
            AND c.post_commit_request_hash IS NOT NULL
            AND c.post_commit_payload_hash IS NOT NULL
            AND c.post_commit_payload->'time_banks'
                  =pg_temp.atomic_hand_obligations()->'time_banks') <> 1
     OR (SELECT count(*) FROM public.hand_projection_outbox o
          WHERE o.hand_id='86400000-0000-0000-0000-000000000001'::uuid
            AND o.table_id='86100000-0000-0000-0000-000000000001'::uuid
            AND o.hand_number=8600001) <> 1
     OR (SELECT count(*) FROM public.tournament_manager_wakes w
          WHERE w.tournament_id='86000000-0000-0000-0000-000000000001'::uuid
            AND w.reason='accepted_hand_bust'
            AND w.generation=1
            AND w.consumed_at IS NULL) <> 1 THEN
    RAISE EXCEPTION
      'FAIL public protocol-2 hand RPC did not commit/replay exact bust generation, closed-seat time bank, candidate, history and receipt once: %, replay %, state %',
      v_result,v_replay,v_after;
  END IF;

END;
$success_replay_probe$;

-- The accepted zero-hand candidate is also the sole authority for its paid
-- replacement. Prove the public purchase commits debit, pool, candidate,
-- positive chair, roster mirrors, wake and immutable response together. The
-- second call arrives after the candidate is already closed and must return
-- the first response without moving another chip.
DO $atomic_rebuy_probe$
DECLARE
  v_before_balance numeric;
  v_after_balance numeric;
  v_prize_before numeric;
  v_rake_before numeric;
  v_escrow_prize_before numeric;
  v_escrow_fee_before numeric;
  v_purchase jsonb;
  v_replay jsonb;
  v_candidate_id uuid;
  v_receipt_key text :=
    'tourney:86000000-0000-0000-0000-000000000001:rebuy:'||
    '10000000-0000-0000-0000-000000000001:tok:atomic-boundary-rebuy';
BEGIN
  SELECT c.id INTO STRICT v_candidate_id
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id='86000000-0000-0000-0000-000000000001'::uuid
     AND c.eliminated_user_id=
           '10000000-0000-0000-0000-000000000001'::uuid
     AND c.hand_number=8600001 AND c.state='pending';
  SELECT cm.chip_balance INTO STRICT v_before_balance
    FROM public.club_members cm
   WHERE cm.club_id='20000000-0000-0000-0000-000000000001'::uuid
     AND cm.user_id='10000000-0000-0000-0000-000000000001'::uuid;
  SELECT t.prize_pool,t.total_rake
    INTO STRICT v_prize_before,v_rake_before
    FROM public.tournaments t
   WHERE t.id='86000000-0000-0000-0000-000000000001'::uuid;
  SELECT e.prize_balance,e.fee_balance
    INTO STRICT v_escrow_prize_before,v_escrow_fee_before
    FROM public.tournament_escrow e
   WHERE e.tournament_id='86000000-0000-0000-0000-000000000001'::uuid;

  v_purchase:=public.process_tournament_rebuy(
    '86000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'rebuy',10,10,1,'atomic-boundary-rebuy');
  v_replay:=public.process_tournament_rebuy(
    '86000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'rebuy',10,10,1,'atomic-boundary-rebuy');

  SELECT cm.chip_balance INTO STRICT v_after_balance
    FROM public.club_members cm
   WHERE cm.club_id='20000000-0000-0000-0000-000000000001'::uuid
     AND cm.user_id='10000000-0000-0000-0000-000000000001'::uuid;

  IF v_purchase IS DISTINCT FROM v_replay
     OR v_purchase->>'success'<>'true'
     OR v_purchase->>'seated'<>'true'
     OR v_purchase->>'atomic_tournament_chip_purchase'<>'v1'
     OR v_purchase->>'candidate_id'<>v_candidate_id::text
     OR v_purchase->>'candidate_state'<>'rebought'
     OR (v_purchase->>'stack')::numeric<>10
     OR (v_purchase->>'cost')::numeric<>10
     OR (v_purchase->>'fee')::numeric<>1
     OR (v_purchase->>'bounty_head_funded')::numeric<>0
     OR v_after_balance IS DISTINCT FROM v_before_balance-10
     OR (SELECT t.prize_pool FROM public.tournaments t
          WHERE t.id='86000000-0000-0000-0000-000000000001'::uuid)
          IS DISTINCT FROM v_prize_before+9
     OR (SELECT t.total_rake FROM public.tournaments t
          WHERE t.id='86000000-0000-0000-0000-000000000001'::uuid)
          IS DISTINCT FROM v_rake_before+1
     OR (SELECT e.prize_balance FROM public.tournament_escrow e
          WHERE e.tournament_id=
                  '86000000-0000-0000-0000-000000000001'::uuid)
          IS DISTINCT FROM v_escrow_prize_before+9
     OR (SELECT e.fee_balance FROM public.tournament_escrow e
          WHERE e.tournament_id=
                  '86000000-0000-0000-0000-000000000001'::uuid)
          IS DISTINCT FROM v_escrow_fee_before+1
     OR (SELECT round(COALESCE(sum(r.rake_amount),0),2)
           FROM public.rake_records r
          WHERE r.tournament_id=
                  '86000000-0000-0000-0000-000000000001'::uuid
            AND r.is_tournament)
          IS DISTINCT FROM v_rake_before+1
     OR (SELECT count(*) FROM public.wallet_transactions tx
          WHERE tx.user_id=
                  '10000000-0000-0000-0000-000000000001'::uuid
            AND tx.related_entity_id=
                  '86000000-0000-0000-0000-000000000001'::uuid
            AND tx.type='debit' AND lower(COALESCE(tx.category,''))='rebuy')<>1
     OR (SELECT count(*) FROM public.entry_purchase_idempotency_receipts r
          WHERE r.key_domain='tournament_chip_purchase'
            AND r.idempotency_key=v_receipt_key
            AND r.response IS NOT DISTINCT FROM v_purchase)<>1
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_knockout_candidates c
        WHERE c.id=v_candidate_id AND c.state='rebought'
          AND c.resolved_at IS NOT NULL)
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id=
                '86000000-0000-0000-0000-000000000001'::uuid
          AND tp.user_id='10000000-0000-0000-0000-000000000001'::uuid
          AND tp.status='playing' AND tp.chips=10
          AND tp.rebuy_prompt_until IS NULL
          AND tp.table_id=(v_purchase->>'table_id')::uuid
          AND tp.seat_number=(v_purchase->>'seat_number')::integer)
     OR (SELECT count(*) FROM public.table_seats s
          JOIN public.tables tb ON tb.id=s.table_id
         WHERE tb.tournament_id=
                 '86000000-0000-0000-0000-000000000001'::uuid
           AND s.user_id='10000000-0000-0000-0000-000000000001'::uuid
           AND s.left_at IS NULL AND s.stack=10
           AND s.id=(v_purchase->>'seat_id')::uuid)<>1
     OR (SELECT tb.current_players FROM public.tables tb
          WHERE tb.id=(v_purchase->>'table_id')::uuid)<>2
     OR (SELECT count(*) FROM public.tournament_manager_wakes w
          WHERE w.tournament_id=
                  '86000000-0000-0000-0000-000000000001'::uuid
            AND w.reason='rebuy')<>1 THEN
    RAISE EXCEPTION
      'FAIL atomic rebuy did not conserve its exact debit/prize/rake rails or replay exactly once: purchase %, replay %, balances % -> %',
      v_purchase,v_replay,v_before_balance,v_after_balance;
  END IF;
END;
$atomic_rebuy_probe$;

DO $pass$
BEGIN
  RAISE EXCEPTION
    'AUDIT_TEST_PASS: the tournament hand authority committed and replayed no-bust and bust hands, rolled back injected early and late faults, and the exact accepted zero-hand then authorized one atomic rebuy debit, candidate close, positive live chair, roster/table mirrors, manager wake and immutable replay receipt; fixture and evidence rolled back';
END;
$pass$;
