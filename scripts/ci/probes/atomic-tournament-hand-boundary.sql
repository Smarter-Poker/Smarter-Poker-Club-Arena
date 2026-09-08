-- Run as postgres only on a disposable clone after the stage-one terminal
-- migration. The final AUDIT_TEST_PASS exception intentionally rolls back the
-- fixture, temporary fault and every hand-settlement evidence row.
BEGIN;

DO $fixture_guard$
BEGIN
  IF current_user <> 'postgres'
     OR NOT EXISTS (
       SELECT 1 FROM public.tournaments
        WHERE id='30000000-0000-0000-0000-000000000001'::uuid)
     OR to_regprocedure(
       'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)')
          IS NULL THEN
    RAISE EXCEPTION
      'atomic tournament hand boundary probe requires the disposable stage-one rehearsal database';
  END IF;
END;
$fixture_guard$;

-- The reduced rehearsal template owns the legacy SECURITY DEFINER hand RPC
-- as its fixture role, while the audited body authorizes postgres/service.
-- Production owns it as the migration authority. Normalize only this
-- disposable transaction; the final PASS exception rolls the owner back too.
ALTER FUNCTION public.fn_ca_settle_hand_stacks_absolute(
  uuid,bigint,jsonb,numeric,numeric,text,numeric) OWNER TO postgres;

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
    'current_players',2,'prize_pool',20,'guaranteed_prize',0,
    'prize_pool_finalized',false,'bounty_pool',0,'bounty_pool_paid',0,
    'is_bounty',false,'is_pko',false,'is_mystery_bounty',false
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
    'table_id','86100000-0000-0000-0000-000000000001','seat_number',1
  ))).*
  FROM public.tournament_players tp
 WHERE tp.tournament_id='30000000-0000-0000-0000-000000000001'::uuid
   AND tp.user_id='10000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tournament_players
SELECT (jsonb_populate_record(NULL::public.tournament_players,
  to_jsonb(tp) || jsonb_build_object(
    'id','86200000-0000-0000-0000-000000000002',
    'tournament_id','86000000-0000-0000-0000-000000000001',
    'user_id','10000000-0000-0000-0000-000000000002',
    'chips',10,'status','playing','position',NULL,'prize',0,
    'eliminated_at',NULL,'elimination_sequence',NULL,
    'table_id','86100000-0000-0000-0000-000000000001','seat_number',2
  ))).*
  FROM public.tournament_players tp
 WHERE tp.tournament_id='30000000-0000-0000-0000-000000000001'::uuid
   AND tp.user_id='10000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.table_seats
  (id,table_id,seat_number,user_id,stack,status,left_at,leave_pending,
   is_sitting_out,is_away,club_id)
VALUES
  ('86300000-0000-0000-0000-000000000001',
   '86100000-0000-0000-0000-000000000001',1,
   '10000000-0000-0000-0000-000000000001',10,'active',NULL,false,false,false,
   '20000000-0000-0000-0000-000000000001'),
  ('86300000-0000-0000-0000-000000000002',
   '86100000-0000-0000-0000-000000000001',2,
   '10000000-0000-0000-0000-000000000002',10,'active',NULL,false,false,false,
   '20000000-0000-0000-0000-000000000001');

SET LOCAL session_replication_role = origin;

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
  v_result := public.fn_ca_settle_hand_stacks_absolute(
    '86100000-0000-0000-0000-000000000001',1,
    jsonb_build_array(
      jsonb_build_object('user_id','10000000-0000-0000-0000-000000000001','stack',0),
      jsonb_build_object('user_id','10000000-0000-0000-0000-000000000002','stack',20)),
    NULL,NULL,'atomic-zero-seat',NULL);
  v_after := pg_temp.atomic_hand_gameplay_state();
  IF COALESCE((v_result->>'success')::boolean,true) IS NOT FALSE
     OR v_result->>'reason' <> 'rolled_back'
     OR v_result->>'error' NOT LIKE '%injected zero-stack seat vacate failure%'
     OR v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION
      'FAIL zero-stack vacate fault did not roll final seat, player and table state back exactly: %',
      v_result;
  END IF;
END;
$rollback_probe$;

DROP TRIGGER zz_probe_reject_zero_stack_vacate ON public.table_seats;

DO $success_replay_probe$
DECLARE
  v_result jsonb;
  v_replay jsonb;
  v_after jsonb;
BEGIN
  v_result := public.fn_ca_settle_hand_stacks_absolute(
    '86100000-0000-0000-0000-000000000001',1,
    jsonb_build_array(
      jsonb_build_object('user_id','10000000-0000-0000-0000-000000000001','stack',0),
      jsonb_build_object('user_id','10000000-0000-0000-0000-000000000002','stack',20)),
    NULL,NULL,'atomic-zero-seat',NULL);
  v_after := pg_temp.atomic_hand_gameplay_state();
  v_replay := public.fn_ca_settle_hand_stacks_absolute(
    '86100000-0000-0000-0000-000000000001',1,
    jsonb_build_array(
      jsonb_build_object('user_id','10000000-0000-0000-0000-000000000001','stack',0),
      jsonb_build_object('user_id','10000000-0000-0000-0000-000000000002','stack',20)),
    NULL,NULL,'atomic-zero-seat',NULL);

  IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result->>'tournament_players_synced')::boolean,false)
          IS NOT TRUE
     OR COALESCE((v_result->>'tournament_zero_stack_seats_vacated')::boolean,false)
          IS NOT TRUE
     OR (v_result->>'tournament_player_count')::integer <> 2
     OR (v_result->>'tournament_zero_stack_seat_count')::integer <> 1
     OR v_result->'tournament_zero_stack_seat_ids' <>
          jsonb_build_array('86300000-0000-0000-0000-000000000001')
     OR v_result->'tournament_zero_stack_user_ids' <>
          jsonb_build_array('10000000-0000-0000-0000-000000000001')
     OR COALESCE((v_replay->>'success')::boolean,false) IS NOT TRUE
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
          AND s.stack=0 AND s.left_at IS NOT NULL AND s.status='left'
          AND COALESCE(s.leave_pending,false) IS FALSE
          AND COALESCE(s.is_sitting_out,false) IS FALSE
          AND COALESCE(s.is_away,false) IS FALSE)
     OR NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.id='86300000-0000-0000-0000-000000000002'::uuid
          AND s.stack=20 AND s.left_at IS NULL)
     OR (SELECT tb.current_players FROM public.tables tb
          WHERE tb.id='86100000-0000-0000-0000-000000000001'::uuid) <> 1 THEN
    RAISE EXCEPTION
      'FAIL tournament hand did not atomically mirror final stacks, vacate the zero seat and replay exactly: %, replay %, state %',
      v_result,v_replay,v_after;
  END IF;

  RAISE EXCEPTION
    'AUDIT_TEST_PASS: the tournament hand authority mirrored both final stacks, vacated exactly the named zero-stack seat, preserved the zero-chip playing row for rebuy or elimination, updated table headcount, rolled all gameplay rows back on an injected vacate fault, and replayed without mutation; fixture and evidence rolled back';
END;
$success_replay_probe$;
