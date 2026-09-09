-- Run as postgres only after the stage-one cancellation migration is installed
-- on a disposable rehearsal database. The transaction is always rolled back,
-- including the synthetic union, games, command receipts, and cancellation
-- receipt used to prove the live installed definitions.
BEGIN;

SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '8s';
SET LOCAL session_replication_role = replica;

INSERT INTO auth.users(id)
VALUES
  ('91000000-0000-0000-0000-000000000001'),
  ('91000000-0000-0000-0000-000000000002'),
  ('91000000-0000-0000-0000-000000000003'),
  ('91000000-0000-0000-0000-000000000004');

INSERT INTO public.users(id,username)
VALUES
  ('91000000-0000-0000-0000-000000000001','managed-cancel-union-admin'),
  ('91000000-0000-0000-0000-000000000002','managed-cancel-club-owner'),
  ('91000000-0000-0000-0000-000000000003','managed-cancel-union-owner'),
  ('91000000-0000-0000-0000-000000000004','managed-cancel-entrant');

INSERT INTO public.unions(id,name,owner_id,slug)
VALUES (
  '92000000-0000-0000-0000-000000000001',
  'Managed Cancellation Probe Union',
  '91000000-0000-0000-0000-000000000003',
  'managed-cancellation-probe-union');

INSERT INTO public.clubs(id,name,owner_id,union_id)
VALUES (
  '93000000-0000-0000-0000-000000000001',
  'Managed Cancellation Probe Club',
  '91000000-0000-0000-0000-000000000002',
  '92000000-0000-0000-0000-000000000001');

INSERT INTO public.union_admins(union_id,user_id,role)
VALUES (
  '92000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000001',
  'union_admin');

INSERT INTO public.tournaments(
  id,name,buy_in_amount,buy_in_fee,start_time,status,max_players,club_id,
  union_id,prize_pool,bounty_pool,total_rake,current_players)
VALUES
  ('94000000-0000-0000-0000-000000000001',
   'Managed Empty Cancellation Probe',0,0,now()+interval '1 day',
   'ANNOUNCED',9,'93000000-0000-0000-0000-000000000001',
   '92000000-0000-0000-0000-000000000001',0,0,0,0),
  ('94000000-0000-0000-0000-000000000002',
   'Managed Registered Refusal Probe',0,0,now()+interval '1 day',
   'ANNOUNCED',9,'93000000-0000-0000-0000-000000000001',
   '92000000-0000-0000-0000-000000000001',0,0,0,1),
  ('94000000-0000-0000-0000-000000000003',
   'Managed Unauthorized Refusal Probe',0,0,now()+interval '1 day',
   'ANNOUNCED',9,'93000000-0000-0000-0000-000000000001',
   '92000000-0000-0000-0000-000000000001',0,0,0,0);

INSERT INTO public.tournament_escrow(tournament_id,opened_from)
VALUES
  ('94000000-0000-0000-0000-000000000001','managed_cancel_probe'),
  ('94000000-0000-0000-0000-000000000003','managed_cancel_probe');

INSERT INTO public.tournament_players(id,tournament_id,user_id,status)
VALUES (
  '96000000-0000-0000-0000-000000000001',
  '94000000-0000-0000-0000-000000000002',
  '91000000-0000-0000-0000-000000000004',
  'registered');

INSERT INTO public.managed_game_contract_versions(
  game_kind,game_id,club_id,union_id,version,contract,contract_hash,
  published_by,change_reason)
VALUES
  ('tournament','94000000-0000-0000-0000-000000000001',
   '93000000-0000-0000-0000-000000000001',
   '92000000-0000-0000-0000-000000000001',1,'{}',repeat('0',64),
   '91000000-0000-0000-0000-000000000001','probe_fixture'),
  ('tournament','94000000-0000-0000-0000-000000000002',
   '93000000-0000-0000-0000-000000000001',
   '92000000-0000-0000-0000-000000000001',1,'{}',repeat('0',64),
   '91000000-0000-0000-0000-000000000001','probe_fixture');

SET LOCAL session_replication_role = origin;

DO $source_and_success$
DECLARE
  v_atomic text;
  v_wrapper text;
  v_close text;
  v_gateway text;
  v_result jsonb;
BEGIN
  IF current_user <> 'postgres'
     OR to_regclass('public.tournament_cancellation_receipts') IS NULL
     OR to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)') IS NULL
     OR to_regprocedure(
          'public.atomic_cancel_tournament_pre_seat_guard(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_close_managed_game(text,uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_execute_managed_game_command(uuid,text,uuid,text,integer,jsonb)')
          IS NULL THEN
    RAISE EXCEPTION
      'FAIL managed cancellation probe requires a disposable installed rehearsal database';
  END IF;

  SELECT p.prosrc INTO v_atomic FROM pg_proc p
   WHERE p.oid=
     'public.atomic_cancel_tournament_pre_seat_guard(uuid,uuid)'::regprocedure;
  SELECT p.prosrc INTO v_wrapper FROM pg_proc p
   WHERE p.oid='public.atomic_cancel_tournament(uuid,uuid)'::regprocedure;
  SELECT p.prosrc INTO v_close FROM pg_proc p
   WHERE p.oid='public.fn_close_managed_game(text,uuid)'::regprocedure;
  SELECT p.prosrc INTO v_gateway FROM pg_proc p
   WHERE p.oid=
     'public.fn_execute_managed_game_command(uuid,text,uuid,text,integer,jsonb)'
       ::regprocedure;

  IF position('ca:tournament-terminal-settlement:v1' IN v_close)=0
     OR position('ca:tournament-terminal-settlement:v1' IN v_close)
          >=position('FROM public.tournaments' IN v_close)
     OR position('ca:tournament-terminal-settlement:v1' IN v_gateway)=0
     OR position('ca:tournament-terminal-settlement:v1' IN v_gateway)
          >=position('FROM public.tournaments' IN v_gateway)
     OR v_close ~* 'update[[:space:]]+public[.]tournaments'
     OR v_close NOT LIKE '%atomic_cancel_tournament(p_game_id, v_uid)%'
     OR v_close NOT LIKE '%players_registered%'
     OR v_atomic NOT LIKE '%fn_can_create_games(v_t.club_id,v_uid)%'
     OR v_atomic LIKE '%is_club_admin(v_t.club_id,v_uid)%'
     OR v_wrapper NOT LIKE '%managed_game_command_receipts%'
     OR v_wrapper NOT LIKE '%r.status=''processing''%'
     OR v_wrapper NOT LIKE '%p_admin_id IS NOT DISTINCT FROM v_uid%' THEN
    RAISE EXCEPTION 'FAIL installed managed cancellation source bypasses authority or lock order';
  END IF;

  IF NOT has_function_privilege(
       'service_role','public.atomic_cancel_tournament(uuid,uuid)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.atomic_cancel_tournament(uuid,uuid)','EXECUTE')
     OR has_function_privilege(
       'anon','public.atomic_cancel_tournament(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_close_managed_game(text,uuid)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.fn_close_managed_game(text,uuid)','EXECUTE')
     OR has_function_privilege(
       'anon','public.fn_close_managed_game(text,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'FAIL managed cancellation private authority ACL changed';
  END IF;

  IF NOT public.fn_can_create_games(
       '93000000-0000-0000-0000-000000000001',
       '91000000-0000-0000-0000-000000000001')
     OR public.fn_can_create_games(
       '93000000-0000-0000-0000-000000000001',
       '91000000-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'FAIL synthetic affiliated club does not enforce union governance';
  END IF;

  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config(
    'request.jwt.claim.sub','91000000-0000-0000-0000-000000000001',true);
  v_result:=public.fn_execute_managed_game_command(
    '95000000-0000-0000-0000-000000000001','tournament',
    '94000000-0000-0000-0000-000000000001','close',1,'{}');

  IF v_result->>'ok' IS DISTINCT FROM 'true'
     OR v_result->>'command_status' IS DISTINCT FROM 'succeeded'
     OR v_result->>'reason' IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id='94000000-0000-0000-0000-000000000001'
          AND t.status='CANCELLED')
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_cancellation_receipts r
        WHERE r.tournament_id='94000000-0000-0000-0000-000000000001'
          AND r.actor_id='91000000-0000-0000-0000-000000000001'
          AND r.source_player_count=0
          AND r.refunded_count=0
          AND r.ticket_return_count=0
          AND r.total_refunded=0
          AND r.total_ticket_returned=0) THEN
    RAISE EXCEPTION 'FAIL union-authorized managed close did not commit one exact cancellation receipt: %',
      v_result;
  END IF;
END;
$source_and_success$;

-- Force the deferred cancellation invariant now. A receiptless direct status
-- update would fail here instead of appearing to pass only because the probe
-- later rolls its transaction back.
SET CONSTRAINTS ALL IMMEDIATE;

DO $refusals_and_replay$
DECLARE
  v_result jsonb;
  v_caught boolean := false;
BEGIN
  PERFORM set_config(
    'request.jwt.claim.sub','91000000-0000-0000-0000-000000000001',true);
  v_result:=public.fn_execute_managed_game_command(
    '95000000-0000-0000-0000-000000000001','tournament',
    '94000000-0000-0000-0000-000000000001','close',1,'{}');
  IF v_result->>'ok' IS DISTINCT FROM 'true'
     OR v_result->>'command_status' IS DISTINCT FROM 'succeeded'
     OR v_result->>'replayed' IS DISTINCT FROM 'true'
     OR (SELECT count(*) FROM public.tournament_cancellation_receipts r
          WHERE r.tournament_id='94000000-0000-0000-0000-000000000001')<>1 THEN
    RAISE EXCEPTION 'FAIL managed close replay changed its committed result: %',v_result;
  END IF;

  v_result:=public.fn_execute_managed_game_command(
    '95000000-0000-0000-0000-000000000002','tournament',
    '94000000-0000-0000-0000-000000000002','close',1,'{}');
  IF v_result->>'ok' IS DISTINCT FROM 'false'
     OR v_result->>'command_status' IS DISTINCT FROM 'rejected'
     OR v_result->>'reason' IS DISTINCT FROM 'players_registered'
     OR EXISTS (
       SELECT 1 FROM public.tournament_cancellation_receipts r
        WHERE r.tournament_id='94000000-0000-0000-0000-000000000002')
     OR (SELECT status FROM public.tournaments t
          WHERE t.id='94000000-0000-0000-0000-000000000002')
          IS DISTINCT FROM 'ANNOUNCED' THEN
    RAISE EXCEPTION 'FAIL managed close crossed the registered-player refusal: %',v_result;
  END IF;

  PERFORM set_config(
    'request.jwt.claim.sub','91000000-0000-0000-0000-000000000002',true);
  BEGIN
    PERFORM public.atomic_cancel_tournament(
      '94000000-0000-0000-0000-000000000003',
      '91000000-0000-0000-0000-000000000002');
  EXCEPTION WHEN SQLSTATE '28000' OR insufficient_privilege THEN
    v_caught:=true;
  END;
  IF NOT v_caught
     OR EXISTS (
       SELECT 1 FROM public.tournament_cancellation_receipts r
        WHERE r.tournament_id='94000000-0000-0000-0000-000000000003')
     OR (SELECT status FROM public.tournaments t
          WHERE t.id='94000000-0000-0000-0000-000000000003')
          IS DISTINCT FROM 'ANNOUNCED' THEN
    RAISE EXCEPTION 'FAIL affiliated club owner bypassed union cancellation authority';
  END IF;
END;
$refusals_and_replay$;

ROLLBACK;

SELECT 'MANAGED_TOURNAMENT_CANCELLATION_AUTHORITY_PASS' AS result;
