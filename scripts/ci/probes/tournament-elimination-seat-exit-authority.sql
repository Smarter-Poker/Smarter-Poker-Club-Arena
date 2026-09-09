-- Run as postgres on a disposable production-shape clone after
-- 20260909014545. Both fixtures model the supported rolling-window path: an
-- old pod committed exact zero-stack evidence before knockout candidates were
-- introduced. The final PASS exception rolls every fixture row back.
BEGIN;

DO $fixture_guard$
BEGIN
  IF current_user<>'postgres'
     OR to_regprocedure(
       'public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)')
        IS NULL
     OR to_regprocedure(
       'public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)')
        IS NULL
     OR to_regprocedure(
       'public.fn_tournament_live_seat_exit_requires_authority()') IS NULL THEN
    RAISE EXCEPTION
      'elimination authority probe requires the disposable post-cutover database';
  END IF;
END;
$fixture_guard$;

SET LOCAL session_replication_role=replica;

INSERT INTO public.profiles(id,username,display_name)
VALUES
  ('97000000-0000-4000-8000-000000000001','seat_exit_plain_bust',
   'Seat Exit Plain Bust'),
  ('97000000-0000-4000-8000-000000000002','seat_exit_plain_survivor',
   'Seat Exit Plain Survivor'),
  ('97000000-0000-4000-8000-000000000003','seat_exit_bounty_bust',
   'Seat Exit Bounty Bust'),
  ('97000000-0000-4000-8000-000000000004','seat_exit_bounty_survivor',
   'Seat Exit Bounty Survivor');

INSERT INTO public.clubs(id,name,owner_id,chip_treasury)
VALUES(
  '97010000-0000-4000-8000-000000000001','Elimination Authority Probe',
  '97000000-0000-4000-8000-000000000002',100000);

INSERT INTO public.tournaments(
  id,name,club_id,buy_in_amount,buy_in_fee,start_time,status,max_players,
  current_players,starting_chips,variant,tournament_type,
  is_bounty,is_pko,is_mystery_bounty,bounty_amount)
VALUES
  ('97100000-0000-4000-8000-000000000001',
   'Plain Old Pod Elimination Probe',
   '97010000-0000-4000-8000-000000000001',10,0,now()-interval '1 hour',
   'RUNNING',9,2,1000,'mtt','MTT',false,false,false,0),
  ('97100000-0000-4000-8000-000000000002',
   'Bounty Old Pod Elimination Probe',
   '97010000-0000-4000-8000-000000000001',10,0,now()-interval '1 hour',
   'RUNNING',9,2,1000,'mtt','MTT',true,false,false,5);

INSERT INTO public.tables(
  id,name,club_id,tournament_id,status,current_players,small_blind,big_blind,
  stakes,max_players,game_type)
VALUES
  ('97200000-0000-4000-8000-000000000001','Plain Elimination Table',
   '97010000-0000-4000-8000-000000000001',
   '97100000-0000-4000-8000-000000000001','running',2,5,10,'5/10',9,
   'tournament'),
  ('97200000-0000-4000-8000-000000000002','Bounty Elimination Table',
   '97010000-0000-4000-8000-000000000001',
   '97100000-0000-4000-8000-000000000002','running',2,5,10,'5/10',9,
   'tournament');

INSERT INTO public.tournament_players(
  id,tournament_id,user_id,club_id,status,chips,table_id,seat_number,
  position,prize,current_bounty,bounty_winnings,eliminated_at,
  elimination_sequence)
VALUES
  ('97500000-0000-4000-8000-000000000001',
   '97100000-0000-4000-8000-000000000001',
   '97000000-0000-4000-8000-000000000001',
   '97010000-0000-4000-8000-000000000001','playing',0,
   '97200000-0000-4000-8000-000000000001',1,NULL,0,0,0,NULL,NULL),
  ('97500000-0000-4000-8000-000000000002',
   '97100000-0000-4000-8000-000000000001',
   '97000000-0000-4000-8000-000000000002',
   '97010000-0000-4000-8000-000000000001','playing',100,
   '97200000-0000-4000-8000-000000000001',2,NULL,0,0,0,NULL,NULL),
  ('97500000-0000-4000-8000-000000000003',
   '97100000-0000-4000-8000-000000000002',
   '97000000-0000-4000-8000-000000000003',
   '97010000-0000-4000-8000-000000000001','playing',0,
   '97200000-0000-4000-8000-000000000002',1,NULL,0,5,0,NULL,NULL),
  ('97500000-0000-4000-8000-000000000004',
   '97100000-0000-4000-8000-000000000002',
   '97000000-0000-4000-8000-000000000004',
   '97010000-0000-4000-8000-000000000001','playing',100,
   '97200000-0000-4000-8000-000000000002',2,NULL,0,5,0,NULL,NULL);

INSERT INTO public.table_seats(
  id,table_id,seat_number,user_id,stack,status,joined_at,left_at,
  leave_pending,is_sitting_out,is_away,club_id)
VALUES
  ('97300000-0000-4000-8000-000000000001',
   '97200000-0000-4000-8000-000000000001',1,
   '97000000-0000-4000-8000-000000000001',0,'active',
   now()-interval '2 minutes',NULL,false,false,false,
   '97010000-0000-4000-8000-000000000001'),
  ('97300000-0000-4000-8000-000000000002',
   '97200000-0000-4000-8000-000000000001',2,
   '97000000-0000-4000-8000-000000000002',100,'active',
   now()-interval '2 minutes',NULL,false,false,false,
   '97010000-0000-4000-8000-000000000001'),
  ('97300000-0000-4000-8000-000000000003',
   '97200000-0000-4000-8000-000000000002',1,
   '97000000-0000-4000-8000-000000000003',0,'active',
   now()-interval '2 minutes',NULL,false,false,false,
   '97010000-0000-4000-8000-000000000001'),
  ('97300000-0000-4000-8000-000000000004',
   '97200000-0000-4000-8000-000000000002',2,
   '97000000-0000-4000-8000-000000000004',100,'active',
   now()-interval '2 minutes',NULL,false,false,false,
   '97010000-0000-4000-8000-000000000001');

INSERT INTO public.settlement_idempotency_keys(
  table_id,hand_id,status,result,completed_at)
VALUES
  ('97200000-0000-4000-8000-000000000001',
   '97400000-0000-4000-8000-000000000001','succeeded',
   jsonb_build_object(
     'hand_number',9900001,
     'table_id','97200000-0000-4000-8000-000000000001',
     'written',jsonb_build_object(
       '97000000-0000-4000-8000-000000000001',0)),
   now()-interval '1 minute'),
  ('97200000-0000-4000-8000-000000000002',
   '97400000-0000-4000-8000-000000000002','succeeded',
   jsonb_build_object(
     'hand_number',9900002,
     'table_id','97200000-0000-4000-8000-000000000002',
     'written',jsonb_build_object(
       '97000000-0000-4000-8000-000000000003',0)),
   now()-interval '1 minute');

INSERT INTO public.hand_history(
  id,table_id,tournament_id,hand_number,created_at,players,pots,winners)
VALUES(
  '97400000-0000-4000-8000-000000000002',
  '97200000-0000-4000-8000-000000000002',
  '97100000-0000-4000-8000-000000000002',9900002,
  now()-interval '30 seconds',
  jsonb_build_array(
    jsonb_build_object(
      'userId','97000000-0000-4000-8000-000000000003','stack',0),
    jsonb_build_object(
      'userId','97000000-0000-4000-8000-000000000004','stack',100)),
  jsonb_build_array(jsonb_build_object(
    'index',0,'amount',100,'eligible',jsonb_build_array(
      '97000000-0000-4000-8000-000000000003',
      '97000000-0000-4000-8000-000000000004'))),
  jsonb_build_array(jsonb_build_object(
    'userId','97000000-0000-4000-8000-000000000004',
    'potIndex',0,'amount',100)));

SET LOCAL session_replication_role=origin;

CREATE FUNCTION pg_temp.elimination_probe_state(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public','pg_temp'
AS $state$
  SELECT jsonb_build_object(
    'players',COALESCE((SELECT jsonb_agg(to_jsonb(tp) ORDER BY tp.id)
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id),'[]'::jsonb),
    'seats',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id),'[]'::jsonb),
    'tables',COALESCE((SELECT jsonb_agg(to_jsonb(tb) ORDER BY tb.id)
      FROM public.tables tb
     WHERE tb.tournament_id=p_tournament_id),'[]'::jsonb),
    'obligations',COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id)
      FROM public.tournament_bounty_obligations o
     WHERE o.tournament_id=p_tournament_id),'[]'::jsonb),
    'authorizations',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.seat_id)
      FROM public.tournament_seat_exit_authorizations a
     WHERE a.tournament_id=p_tournament_id),'[]'::jsonb));
$state$;

DO $exercise$
DECLARE
  v_plain jsonb;
  v_plain_replay jsonb;
  v_plain_after jsonb;
  v_bounty jsonb;
  v_bounty_replay jsonb;
  v_bounty_after jsonb;
BEGIN
  v_plain:=public.fn_eliminate_tournament_player_atomic(
    '97100000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000001',2,0,0);
  v_plain_after:=pg_temp.elimination_probe_state(
    '97100000-0000-4000-8000-000000000001');
  v_plain_replay:=public.fn_eliminate_tournament_player_atomic(
    '97100000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000001',2,0,0);

  IF COALESCE((v_plain->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_plain->>'claimed')::boolean,false) IS NOT TRUE
     OR COALESCE((v_plain_replay->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_plain_replay->>'already')::boolean,false) IS NOT TRUE
     OR pg_temp.elimination_probe_state(
          '97100000-0000-4000-8000-000000000001')
          IS DISTINCT FROM v_plain_after
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id='97100000-0000-4000-8000-000000000001'
          AND tp.user_id='97000000-0000-4000-8000-000000000001'
          AND tp.status='eliminated' AND tp.position=2 AND tp.prize=0)
     OR NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.id='97300000-0000-4000-8000-000000000001'
          AND s.left_at IS NOT NULL)
     OR (SELECT current_players FROM public.tables
          WHERE id='97200000-0000-4000-8000-000000000001')<>1
     OR EXISTS (
       SELECT 1 FROM public.tournament_seat_exit_authorizations a
        WHERE a.tournament_id='97100000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION
      'FAIL non-bounty legacy elimination did not close and replay exactly: %, %, %',
      v_plain,v_plain_replay,v_plain_after;
  END IF;

  v_bounty:=public.fn_claim_tournament_bounty_elimination(
    '97100000-0000-4000-8000-000000000002',
    '97000000-0000-4000-8000-000000000003',2,0,
    '97200000-0000-4000-8000-000000000002',
    '97400000-0000-4000-8000-000000000002',9900002,
    (SELECT joined_at FROM public.table_seats
      WHERE id='97300000-0000-4000-8000-000000000003'),
    '97000000-0000-4000-8000-000000000004',NULL,0,false);
  v_bounty_after:=pg_temp.elimination_probe_state(
    '97100000-0000-4000-8000-000000000002');
  v_bounty_replay:=public.fn_claim_tournament_bounty_elimination(
    '97100000-0000-4000-8000-000000000002',
    '97000000-0000-4000-8000-000000000003',2,0,
    '97200000-0000-4000-8000-000000000002',
    '97400000-0000-4000-8000-000000000002',9900002,
    (SELECT joined_at FROM public.table_seats
      WHERE id='97300000-0000-4000-8000-000000000003'),
    '97000000-0000-4000-8000-000000000004',NULL,0,false);

  IF COALESCE((v_bounty->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_bounty->>'claimed')::boolean,false) IS NOT TRUE
     OR COALESCE((v_bounty_replay->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_bounty_replay->>'already')::boolean,false) IS NOT TRUE
     OR pg_temp.elimination_probe_state(
          '97100000-0000-4000-8000-000000000002')
          IS DISTINCT FROM v_bounty_after
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id='97100000-0000-4000-8000-000000000002'
          AND tp.user_id='97000000-0000-4000-8000-000000000003'
          AND tp.status='eliminated' AND tp.position=2 AND tp.prize=0)
     OR NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.id='97300000-0000-4000-8000-000000000003'
          AND s.left_at IS NOT NULL)
     OR (SELECT current_players FROM public.tables
          WHERE id='97200000-0000-4000-8000-000000000002')<>1
     OR (SELECT count(*) FROM public.tournament_bounty_obligations o
          WHERE o.tournament_id='97100000-0000-4000-8000-000000000002'
            AND o.eliminated_user_id=
                '97000000-0000-4000-8000-000000000003')<>1
     OR EXISTS (
       SELECT 1 FROM public.tournament_seat_exit_authorizations a
        WHERE a.tournament_id='97100000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION
      'FAIL bounty legacy elimination did not close and replay exactly: %, %, %',
      v_bounty,v_bounty_replay,v_bounty_after;
  END IF;

  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION
    'AUDIT_TEST_PASS: non-bounty and bounty old-pod eliminations each consumed one scoped seat-exit capability, committed roster/seat/table/outbox state atomically, replayed without mutation, and left no authorization row; fixture rolled back';
END;
$exercise$;
