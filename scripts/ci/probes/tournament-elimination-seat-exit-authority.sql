-- Run as postgres on a disposable production-shape clone after
-- 20260909014545. Both fixtures carry the complete accepted-hand chain. The
-- hand-history UUID deliberately differs from the internal settlement request
-- UUID, proving that no layer conflates those identities. One exact live zero
-- seat remains only to exercise the cutover seat-exit capability. The final
-- PASS exception rolls every fixture row back.
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

DO $knockout_generation_guard$
DECLARE
  v_hand text;
  v_plain text;
  v_bounty text;
  v_bounty_core text;
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.tournament_knockout_candidates'::regclass
          AND c.conname=
            'tournament_knockout_candidate_tournament_id_eliminated_user_key'
          AND pg_get_constraintdef(c.oid)=
            'UNIQUE (tournament_id, eliminated_user_id, seat_joined_at)')
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.tournament_bounty_obligations'::regclass
          AND c.conname=
            'tournament_bounty_obligations_tournament_id_eliminated_user_key'
          AND pg_get_constraintdef(c.oid)=
            'UNIQUE (tournament_id, eliminated_user_id, seat_joined_at)')
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.tournament_knockout_candidates'::regclass
          AND c.conname=
            'tournament_knockout_candidate_tournament_id_hand_number_eli_key'
          AND pg_get_constraintdef(c.oid)=
            'UNIQUE (tournament_id, hand_number, eliminated_user_id)')
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.tournament_bounty_obligations'::regclass
          AND c.conname=
            'tournament_bounty_obligations_tournament_id_hand_number_eli_key'
          AND pg_get_constraintdef(c.oid)=
            'UNIQUE (tournament_id, hand_number, eliminated_user_id)')
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.hand_atomic_commits'::regclass
          AND c.conname='hand_atomic_commits_hand_number_key'
          AND pg_get_constraintdef(c.oid)='UNIQUE (hand_number)')
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.hand_projection_outbox'::regclass
          AND c.conname='hand_projection_outbox_hand_number_key'
          AND pg_get_constraintdef(c.oid)='UNIQUE (hand_number)')
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.hand_atomic_commits'::regclass
          AND c.contype='p'
          AND pg_get_constraintdef(c.oid)=
            'PRIMARY KEY (table_id, hand_number)') THEN
    RAISE EXCEPTION
      'FAIL global hand or immutable knockout-generation identity changed';
  END IF;

  SELECT p.prosrc INTO v_hand FROM pg_proc p
   WHERE p.oid=
    'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure;
  SELECT p.prosrc INTO v_plain FROM pg_proc p
   WHERE p.oid=
    'public.fn_eliminate_tournament_player_atomic_pre_seat_guard(uuid,uuid,integer,numeric,numeric)'::regprocedure;
  SELECT p.prosrc INTO v_bounty FROM pg_proc p
   WHERE p.oid=
    'public.fn_claim_tournament_bounty_elimination_pre_seat_guard(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'::regprocedure;
  SELECT p.prosrc INTO v_bounty_core FROM pg_proc p
   WHERE p.oid=
    'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'::regprocedure;

  IF v_hand IS NULL
     OR position(
          'ON CONFLICT (tournament_id,hand_number,eliminated_user_id) DO NOTHING'
          IN v_hand)=0
     OR position('ON CONFLICT DO NOTHING' IN v_hand)<>0
     OR position('c2.seat_joined_at' IN v_hand)<>0
     OR position('fn_ca_tournament_rebuy_window(v_tournament_id)' IN v_hand)=0
     OR position('v_rebuy_cap' IN v_hand)<>0
     OR v_plain IS NULL
     OR position('SET state=''rebought''' IN v_plain)<>0
     OR position('max(s.joined_at)' IN replace(v_plain,' ',''))<>0
     OR position(
          'fn_ca_latest_committed_knockout_candidate'
          IN v_plain)=0
     OR position('a.table_id=v_candidate.table_id'
                   IN regexp_replace(v_plain,'[[:space:]]+','','g'))=0
     OR position('a.hand_number=v_candidate.hand_number'
                   IN regexp_replace(v_plain,'[[:space:]]+','','g'))=0
     OR position('a.hand_id=v_candidate.hand_id'
                   IN regexp_replace(v_plain,'[[:space:]]+','','g'))=0
     OR position('v_settlement_hand_text:=v_atomic.stack_result->>''hand_id'''
                   IN regexp_replace(v_plain,'[[:space:]]+','','g'))=0
     OR position('k.hand_id=v_settlement_hand_id'
                   IN regexp_replace(v_plain,'[[:space:]]+','','g'))=0
     OR position('ORDER BY (k.result->>''hand_number'')::bigint DESC'
                   IN v_plain)<>0
     OR position('AND c.state<>''rebought''' IN v_plain)=0
     OR position('WHERE c.id=v_candidate.id' IN v_plain)=0
     OR position('AND c.state=''pending''' IN v_plain)=0
     OR v_bounty IS NULL
     OR position('bounty_claim_is_not_latest_knockout_hand' IN v_bounty)=0
     OR position(
          'fn_ca_latest_committed_knockout_candidate' IN v_bounty)=0
     OR position('a.table_id=v_candidate.table_id'
                   IN regexp_replace(v_bounty,'[[:space:]]+','','g'))=0
     OR position('a.hand_number=v_candidate.hand_number'
                   IN regexp_replace(v_bounty,'[[:space:]]+','','g'))=0
     OR position('a.hand_id=v_candidate.hand_id'
                   IN regexp_replace(v_bounty,'[[:space:]]+','','g'))=0
     OR position('k.hand_id=v_settlement_hand_id'
                   IN regexp_replace(v_bounty,'[[:space:]]+','','g'))=0
     OR position('AND c.state<>''rebought''' IN v_bounty)=0
     OR position('WHERE c.id=v_candidate.id' IN v_bounty)=0
     OR position('AND c.state=''pending''' IN v_bounty)=0
     OR v_bounty_core IS NULL
     OR position('o.hand_number=p_hand_number'
                   IN regexp_replace(v_bounty_core,'[[:space:]]+','','g'))=0
     OR position('a.table_id=p_table_id'
                   IN regexp_replace(v_bounty_core,'[[:space:]]+','','g'))=0
     OR position('a.hand_number=p_hand_number'
                   IN regexp_replace(v_bounty_core,'[[:space:]]+','','g'))=0
     OR position('a.hand_id=p_hand_id'
                   IN regexp_replace(v_bounty_core,'[[:space:]]+','','g'))=0
     OR position('k.hand_id=v_settlement_hand_id'
                   IN regexp_replace(v_bounty_core,'[[:space:]]+','','g'))=0
     OR position('o.id=v_obligation_id'
                   IN regexp_replace(v_bounty_core,'[[:space:]]+','','g'))=0
     OR to_regprocedure('public.fn_after_tournament_rebuy(uuid,uuid,text)')
          IS NOT NULL THEN
    RAISE EXCEPTION
      'FAIL exact-hand knockout generation source or retired rebuy authority changed';
  END IF;
END;
$knockout_generation_guard$;

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
   'Plain Exact Hand Elimination Probe',
   '97010000-0000-4000-8000-000000000001',10,0,now()-interval '1 hour',
   'RUNNING',9,2,1000,'mtt','MTT',false,false,false,0),
  ('97100000-0000-4000-8000-000000000002',
   'Bounty Exact Hand Elimination Probe',
   '97010000-0000-4000-8000-000000000001',10,0,now()-interval '1 hour',
   'RUNNING',9,2,1000,'mtt','MTT',true,false,false,5);

-- Exercise both non-add-on branches of the one shared prompt/purchase clock.
-- Candidate creation below calls this same helper; the fixture then disables
-- rebuy so elimination may consume its deliberately expired/no-prompt rows.
DO $rebuy_window_branches$
DECLARE
  v_level jsonb;
  v_timed jsonb;
BEGIN
  UPDATE public.tournaments
     SET is_rebuy=true,is_reentry=false,prize_pool_finalized=false,
         rebuy_levels=5,late_reg_levels=0,late_reg_mins=0,current_level=1
   WHERE id='97100000-0000-4000-8000-000000000001';
  v_level:=public.fn_ca_tournament_rebuy_window(
    '97100000-0000-4000-8000-000000000001');
  IF COALESCE((v_level->>'open')::boolean,false) IS NOT TRUE
     OR COALESCE((v_level->>'level_open')::boolean,false) IS NOT TRUE
     OR (v_level->>'timed_open')::boolean IS DISTINCT FROM false
     OR (v_level->>'prompt_until')::timestamptz<=clock_timestamp()
     OR (v_level->>'prompt_until')::timestamptz>
          clock_timestamp()+interval '31 seconds' THEN
    RAISE EXCEPTION 'FAIL level-bounded rebuy window returned %',v_level;
  END IF;

  UPDATE public.tournaments
     SET is_rebuy=true,is_reentry=false,prize_pool_finalized=false,
         rebuy_levels=0,late_reg_levels=0,late_reg_mins=60,
         current_level=NULL,started_at=clock_timestamp()-interval '10 minutes'
   WHERE id='97100000-0000-4000-8000-000000000002';
  v_timed:=public.fn_ca_tournament_rebuy_window(
    '97100000-0000-4000-8000-000000000002');
  IF COALESCE((v_timed->>'open')::boolean,false) IS NOT TRUE
     OR COALESCE((v_timed->>'timed_open')::boolean,false) IS NOT TRUE
     OR (v_timed->>'level_open')::boolean IS DISTINCT FROM false
     OR (v_timed->>'prompt_until')::timestamptz<=clock_timestamp()
     OR (v_timed->>'prompt_until')::timestamptz>
          clock_timestamp()+interval '31 seconds' THEN
    RAISE EXCEPTION 'FAIL minute-bounded rebuy window returned %',v_timed;
  END IF;

  UPDATE public.tournaments
     SET is_rebuy=false,is_reentry=false
   WHERE id IN (
     '97100000-0000-4000-8000-000000000001',
     '97100000-0000-4000-8000-000000000002');
END;
$rebuy_window_branches$;

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
   '97600000-0000-4000-8000-000000000001','succeeded',
   jsonb_build_object(
     'hand_number',9900001,
     'table_id','97200000-0000-4000-8000-000000000001',
     'written',jsonb_build_object(
       '97000000-0000-4000-8000-000000000001',0)),
   now()-interval '1 minute'),
  ('97200000-0000-4000-8000-000000000002',
   '97600000-0000-4000-8000-000000000002','succeeded',
   jsonb_build_object(
     'hand_number',9900002,
     'table_id','97200000-0000-4000-8000-000000000002',
     'written',jsonb_build_object(
       '97000000-0000-4000-8000-000000000003',0)),
   now()-interval '1 minute');

-- hand_atomic_commits.hand_id is the immutable hand_history id. Its nested
-- stack_result.hand_id is the distinct internal settlement request id that
-- keys settlement_idempotency_keys. Both sides must match before elimination.
INSERT INTO public.hand_atomic_commits(
  table_id,hand_number,hand_id,payload_hash,stack_result,committed_at)
VALUES
  ('97200000-0000-4000-8000-000000000001',9900001,
   '97400000-0000-4000-8000-000000000001',repeat('a',64),
   jsonb_build_object(
     'success',true,
     'hand_id','97600000-0000-4000-8000-000000000001',
     'hand_number',9900001,
     'table_id','97200000-0000-4000-8000-000000000001',
     'written',jsonb_build_object(
       '97000000-0000-4000-8000-000000000001',0)),
   now()-interval '45 seconds'),
  ('97200000-0000-4000-8000-000000000002',9900002,
   '97400000-0000-4000-8000-000000000002',repeat('b',64),
   jsonb_build_object(
     'success',true,
     'hand_id','97600000-0000-4000-8000-000000000002',
     'hand_number',9900002,
     'table_id','97200000-0000-4000-8000-000000000002',
     'written',jsonb_build_object(
       '97000000-0000-4000-8000-000000000003',0)),
   now()-interval '45 seconds');

INSERT INTO public.tournament_knockout_candidates(
  tournament_id,eliminated_user_id,table_id,seat_id,seat_joined_at,
  hand_id,hand_number,stack_before,stack_after,state,rebuy_prompt_until)
VALUES
  ('97100000-0000-4000-8000-000000000001',
   '97000000-0000-4000-8000-000000000001',
   '97200000-0000-4000-8000-000000000001',
   '97300000-0000-4000-8000-000000000001',
   (SELECT joined_at FROM public.table_seats
     WHERE id='97300000-0000-4000-8000-000000000001'),
   '97400000-0000-4000-8000-000000000001',9900001,100,0,'pending',NULL),
  ('97100000-0000-4000-8000-000000000002',
   '97000000-0000-4000-8000-000000000003',
   '97200000-0000-4000-8000-000000000002',
   '97300000-0000-4000-8000-000000000003',
   (SELECT joined_at FROM public.table_seats
     WHERE id='97300000-0000-4000-8000-000000000003'),
   '97400000-0000-4000-8000-000000000002',9900002,100,0,'pending',NULL);

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
       SELECT 1 FROM public.tournament_knockout_candidates c
        WHERE c.tournament_id='97100000-0000-4000-8000-000000000001'
          AND c.eliminated_user_id='97000000-0000-4000-8000-000000000001'
          AND c.table_id='97200000-0000-4000-8000-000000000001'
          AND c.hand_number=9900001
          AND c.hand_id='97400000-0000-4000-8000-000000000001'
          AND c.state='eliminated')
     OR NOT EXISTS (
       SELECT 1
         FROM public.hand_atomic_commits a
         JOIN public.settlement_idempotency_keys k
           ON k.table_id=a.table_id
          AND k.hand_id=(a.stack_result->>'hand_id')::uuid
        WHERE a.table_id='97200000-0000-4000-8000-000000000001'
          AND a.hand_number=9900001
          AND a.hand_id='97400000-0000-4000-8000-000000000001'
          AND a.hand_id<>k.hand_id
          AND k.hand_id='97600000-0000-4000-8000-000000000001'
          AND k.status='succeeded')
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
      'FAIL non-bounty exact-hand elimination did not close and replay exactly: %, %, %',
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
       SELECT 1 FROM public.tournament_knockout_candidates c
        WHERE c.tournament_id='97100000-0000-4000-8000-000000000002'
          AND c.eliminated_user_id='97000000-0000-4000-8000-000000000003'
          AND c.table_id='97200000-0000-4000-8000-000000000002'
          AND c.hand_number=9900002
          AND c.hand_id='97400000-0000-4000-8000-000000000002'
          AND c.state='eliminated')
     OR NOT EXISTS (
       SELECT 1
         FROM public.hand_atomic_commits a
         JOIN public.settlement_idempotency_keys k
           ON k.table_id=a.table_id
          AND k.hand_id=(a.stack_result->>'hand_id')::uuid
        WHERE a.table_id='97200000-0000-4000-8000-000000000002'
          AND a.hand_number=9900002
          AND a.hand_id='97400000-0000-4000-8000-000000000002'
          AND a.hand_id<>k.hand_id
          AND k.hand_id='97600000-0000-4000-8000-000000000002'
          AND k.status='succeeded')
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
      'FAIL bounty exact-hand elimination did not close and replay exactly: %, %, %',
      v_bounty,v_bounty_replay,v_bounty_after;
  END IF;

  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION
    'AUDIT_TEST_PASS: level- and minute-bounded rebuy clocks opened exact capped prompts; non-bounty and bounty eliminations each proved a distinct hand-history id -> atomic commit -> internal settlement request id chain, consumed one scoped seat-exit capability, committed candidate/roster/seat/table/outbox state atomically, replayed without mutation, and left no authorization row; fixture rolled back';
END;
$exercise$;
