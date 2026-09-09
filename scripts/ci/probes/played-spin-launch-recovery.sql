-- Disposable PostgreSQL rehearsal only. This proves that an already-played
-- three-player Spin may finish its incomplete launch after exactly one busted
-- player has vacated, without turning a fresh two-player Spin or Heads-Up SNG
-- into a legal launch. The final PASS exception rolls the whole fixture back.
BEGIN;

DO $fixture_guard$
BEGIN
  IF current_user <> 'postgres'
     OR to_regprocedure('public.fn_spin_draw_and_settle(uuid,jsonb)') IS NULL
     OR to_regprocedure('public.fn_prove_played_spin_launch_recovery(uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)'
        ) IS NULL THEN
    RAISE EXCEPTION
      'played Spin launch probe requires the disposable stage-one rehearsal database plus the played-Spin launch migration';
  END IF;
END;
$fixture_guard$;

SET LOCAL session_replication_role=replica;

INSERT INTO auth.users(id)
SELECT md5('played-spin-launch-user:' || g.i::text)::uuid
  FROM generate_series(1,3) g(i);

INSERT INTO public.profiles(id,username,display_name)
SELECT md5('played-spin-launch-user:' || g.i::text)::uuid,
       'played_spin_launch_' || g.i,
       'Played Spin Launch ' || g.i
  FROM generate_series(1,3) g(i);

INSERT INTO public.clubs(id,name,owner_id,chip_treasury,spins_enabled)
VALUES (
  '92000000-0000-0000-0000-000000000001',
  'Played Spin Launch Probe Club',
  md5('played-spin-launch-user:1')::uuid,
  1000,
  true
);

INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance)
SELECT '92000000-0000-0000-0000-000000000001',
       md5('played-spin-launch-user:' || g.i::text)::uuid,
       CASE WHEN g.i=1 THEN 'owner' ELSE 'player' END,
       'active',
       100
  FROM generate_series(1,3) g(i);

INSERT INTO public.spin_bonus_pools(
  id,club_id,balance,total_deposited,total_drawn,spin_count,bonus_count,
  seeded_amount,ceiling_amount,highest_stake,surplus_returned,is_active,
  owner_kind,offered_max_stake,seed_returned_amount,required_seed_at_activation
) VALUES (
  '92030000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  1000,1000,0,0,0,0,10000,1,0,true,'club',1,0,0
);

INSERT INTO public.tournaments(
  id,club_id,name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,
  start_time,status,current_players,max_players,min_players,starting_chips,
  blind_structure,table_size,prize_pool,payout_structure,spin_multiplier,spin_locked_tiers,
  synchronized_breaks
) VALUES (
  '92010000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  'Played Spin Launch Recovery',
  'NLH','spin','SPIN',1,0,now(),'REGISTERING',3,3,3,1000,
  '[{"level":1,"smallBlind":10,"bigBlind":20,"ante":0,"duration":180}]',3,3,
  '[{"place":1,"percentage":100}]',0,NULL,false
);

INSERT INTO public.tables(
  id,club_id,name,game_type,game_variant,max_players,current_players,status,
  starting_chips,is_spins,tournament_id,lifecycle
) VALUES (
  '92020000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  'Played Spin Launch Table',
  'tournament','nlh',3,3,'waiting',1000,true,
  '92010000-0000-0000-0000-000000000001','live'
);

INSERT INTO public.tournament_players(
  id,tournament_id,user_id,username,chips,status,table_id,seat_number,club_id
)
SELECT md5('played-spin-launch-player:' || g.i::text)::uuid,
       '92010000-0000-0000-0000-000000000001',
       md5('played-spin-launch-user:' || g.i::text)::uuid,
       'Played Spin Launch ' || g.i,
       1000,
       'playing',
       '92020000-0000-0000-0000-000000000001',
       g.i,
       '92000000-0000-0000-0000-000000000001'
  FROM generate_series(1,3) g(i);

INSERT INTO public.table_seats(
  id,table_id,seat_number,user_id,stack,status,left_at,leave_pending,
  is_sitting_out,is_away,club_id
)
SELECT md5('played-spin-launch-seat:' || g.i::text)::uuid,
       '92020000-0000-0000-0000-000000000001',
       g.i,
       md5('played-spin-launch-user:' || g.i::text)::uuid,
       1000,
       'active',NULL,false,false,false,
       '92000000-0000-0000-0000-000000000001'
  FROM generate_series(1,3) g(i);

INSERT INTO public.tournament_escrow(
  tournament_id,gross_in,fee_entries_in,satellite_fee_in,bounty_in,overlay_in,
  satellite_in,prize_out,bounty_out,fee_out,refund_prize,refund_bounty,
  refund_fee,reserve_out,reserve_in,prize_balance,bounty_balance,fee_balance,
  opened_from,opened_at,updated_at,enforced
) VALUES (
  '92010000-0000-0000-0000-000000000001',3,0,0,0,0,0,0,0,0,0,0,0,
  0,0,3,0,0,'played-spin-launch-probe',now(),now(),true
);

INSERT INTO public.wallet_transactions(
  id,user_id,wallet_type,amount,type,category,description,related_entity_id,
  balance_after
)
SELECT md5('played-spin-launch-wallet:' || g.i::text)::uuid,
       md5('played-spin-launch-user:' || g.i::text)::uuid,
       'PLAYER',1,'debit','tournament_buyin',
       'Played Spin launch probe buy-in',
       '92010000-0000-0000-0000-000000000001',
       99
  FROM generate_series(1,3) g(i);

INSERT INTO public.chip_ledger(
  id,performed_by,from_type,from_entity_id,to_type,to_entity_id,
  amount,category,club_id,tournament_id,description
)
SELECT md5('played-spin-launch-source-ledger:' || g.i::text)::uuid,
       md5('played-spin-launch-user:' || g.i::text)::uuid,
       'player_wallet',md5('played-spin-launch-user:' || g.i::text)::uuid,
       'prize_liability','92010000-0000-0000-0000-000000000001',
       1,'tournament_buyin','92000000-0000-0000-0000-000000000001',
       '92010000-0000-0000-0000-000000000001',
       'Played Spin launch probe source charge'
  FROM generate_series(1,3) g(i);

INSERT INTO public.tournament_refund_entitlements(
  id,tournament_id,user_id,entitlement_kind,charge_category,
  refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
  source_ledger_id,registration_id,source_satellite_id,source_award_place,
  source_ticket_id,escrow_bucket,evidence_kind
)
SELECT md5('played-spin-launch-entitlement:' || g.i::text)::uuid,
       '92010000-0000-0000-0000-000000000001',
       md5('played-spin-launch-user:' || g.i::text)::uuid,
       'wallet_charge','tournament_buyin',
       '92000000-0000-0000-0000-000000000001',
       1,1,0,0,
       md5('played-spin-launch-source-ledger:' || g.i::text)::uuid,
       NULL,NULL,NULL,NULL,'wallet_gross','cutover_wallet_charge'
  FROM generate_series(1,3) g(i);

INSERT INTO public.tournament_launch_receipts(
  tournament_id,launch_id,started_at,claimed_at,completed_at,lease_generation
) VALUES (
  '92010000-0000-0000-0000-000000000001',
  '92040000-0000-4000-8000-000000000001',
  transaction_timestamp(),transaction_timestamp(),NULL,
  '92050000-0000-4000-8000-000000000001'
);

SET LOCAL session_replication_role=origin;

CREATE TEMP TABLE played_spin_launch_results(
  phase text PRIMARY KEY,
  receipt jsonb NOT NULL
) ON COMMIT DROP;

INSERT INTO played_spin_launch_results(phase,receipt)
SELECT 'initial_draw',public.fn_spin_draw_and_settle(
  '92010000-0000-0000-0000-000000000001',
  '[{"multiplier":2,"freq":4809776,"reserveThresholdX":0},{"multiplier":3,"freq":3930716,"reserveThresholdX":0},{"multiplier":4,"freq":900000,"reserveThresholdX":0},{"multiplier":5,"freq":250000,"reserveThresholdX":0},{"multiplier":10,"freq":100000,"reserveThresholdX":0},{"multiplier":25,"freq":7500,"reserveThresholdX":0},{"multiplier":50,"freq":1000,"reserveThresholdX":0},{"multiplier":100,"freq":1008,"reserveThresholdX":1.5}]'::jsonb
);

SET LOCAL session_replication_role=replica;

UPDATE public.table_seats
   SET stack=CASE seat_number WHEN 1 THEN 0 WHEN 2 THEN 1000 ELSE 2000 END
 WHERE table_id='92020000-0000-0000-0000-000000000001';
UPDATE public.tournament_players
   SET chips=CASE seat_number WHEN 1 THEN 0 WHEN 2 THEN 1000 ELSE 2000 END
 WHERE tournament_id='92010000-0000-0000-0000-000000000001';

UPDATE public.table_seats
   SET left_at=transaction_timestamp(),status='left'
 WHERE table_id='92020000-0000-0000-0000-000000000001'
   AND seat_number=1;
UPDATE public.tournament_players
   SET status='eliminated',table_id=NULL,seat_number=NULL,
       eliminated_at=transaction_timestamp()
 WHERE tournament_id='92010000-0000-0000-0000-000000000001'
   AND user_id=md5('played-spin-launch-user:1')::uuid;
UPDATE public.tables
   SET current_players=2
 WHERE id='92020000-0000-0000-0000-000000000001';

INSERT INTO public.hand_history(
  id,table_id,tournament_id,hand_number,game_variant,pot_size,players,actions,
  started_at,ended_at
) VALUES (
  '92060000-0000-4000-8000-000000000001',
  '92020000-0000-0000-0000-000000000001',
  '92010000-0000-0000-0000-000000000001',
  992000001,'nlh',3000,'[]','[]',
  transaction_timestamp(),transaction_timestamp()
);

SET LOCAL session_replication_role=origin;

DO $positive_preflight$
DECLARE
  v_proof jsonb;
BEGIN
  v_proof := public.fn_prove_played_spin_launch_recovery(
    '92010000-0000-0000-0000-000000000001'
  );
  IF v_proof->>'ok' IS DISTINCT FROM 'true'
     OR v_proof->>'recovery_mode' IS DISTINCT FROM 'played_vacated_spin'
     OR (v_proof->>'original_field')::integer <> 3
     OR (v_proof->>'active_field')::integer <> 2
     OR (v_proof->>'paid_users')::integer <> 3
     OR (v_proof->>'entitlement_users')::integer <> 3
     OR (v_proof->>'live_seats')::integer <> 2
     OR (v_proof->>'hand_count')::integer < 1
     OR (v_proof->>'funding_floor')::numeric <> 3000
     OR (v_proof->>'roster_chips')::numeric <> 3000
     OR (v_proof->>'seat_chips')::numeric <> 3000
     OR jsonb_array_length(v_proof->'original_player_ids') <> 3
     OR jsonb_array_length(v_proof->'active_player_ids') <> 2 THEN
    RAISE EXCEPTION 'FAIL played Spin preflight was not exact: %',v_proof;
  END IF;
END;
$positive_preflight$;

INSERT INTO played_spin_launch_results(phase,receipt)
SELECT 'vacated_draw_replay',public.fn_spin_draw_and_settle(
  '92010000-0000-0000-0000-000000000001',NULL
);

DO $draw_replay_is_immutable$
DECLARE
  v_initial jsonb;
  v_replay jsonb;
  v_key text;
BEGIN
  SELECT receipt INTO v_initial FROM played_spin_launch_results WHERE phase='initial_draw';
  SELECT receipt INTO v_replay FROM played_spin_launch_results WHERE phase='vacated_draw_replay';
  FOREACH v_key IN ARRAY ARRAY[
    'entry_reserve_id','entry_journal_id','draw_reserve_id','draw_journal_id',
    'multiplier','prize_pool','entry_amount','draw_amount','house_rake','pool_id'
  ] LOOP
    IF v_replay->>v_key IS DISTINCT FROM v_initial->>v_key THEN
      RAISE EXCEPTION 'FAIL vacated replay changed % (% versus %)',
        v_key,v_initial->>v_key,v_replay->>v_key;
    END IF;
  END LOOP;
END;
$draw_replay_is_immutable$;

SAVEPOINT missing_hand;
SET LOCAL session_replication_role=replica;
DELETE FROM public.hand_history
 WHERE id='92060000-0000-4000-8000-000000000001';
SET LOCAL session_replication_role=origin;
DO $missing_hand_refused$
BEGIN
  IF COALESCE((public.fn_prove_played_spin_launch_recovery(
       '92010000-0000-0000-0000-000000000001')->>'ok')::boolean,false) THEN
    RAISE EXCEPTION 'FAIL played Spin recovery accepted no persisted hand';
  END IF;
END;
$missing_hand_refused$;
ROLLBACK TO SAVEPOINT missing_hand;

SAVEPOINT missing_draw;
SET LOCAL session_replication_role=replica;
DELETE FROM public.spin_reserve_ledger
 WHERE tournament_id='92010000-0000-0000-0000-000000000001'
   AND kind='jackpot_draw';
SET LOCAL session_replication_role=origin;
DO $missing_draw_refused$
BEGIN
  IF COALESCE((public.fn_prove_played_spin_launch_recovery(
       '92010000-0000-0000-0000-000000000001')->>'ok')::boolean,false) THEN
    RAISE EXCEPTION 'FAIL played Spin recovery accepted no immutable draw';
  END IF;
END;
$missing_draw_refused$;
ROLLBACK TO SAVEPOINT missing_draw;

SAVEPOINT missing_payment;
SET LOCAL session_replication_role=replica;
DELETE FROM public.tournament_refund_entitlements
 WHERE tournament_id='92010000-0000-0000-0000-000000000001'
   AND user_id=md5('played-spin-launch-user:1')::uuid;
SET LOCAL session_replication_role=origin;
DO $missing_payment_refused$
BEGIN
  IF COALESCE((public.fn_prove_played_spin_launch_recovery(
       '92010000-0000-0000-0000-000000000001')->>'ok')::boolean,false) THEN
    RAISE EXCEPTION 'FAIL played Spin recovery accepted two entitlements';
  END IF;
END;
$missing_payment_refused$;
ROLLBACK TO SAVEPOINT missing_payment;

SAVEPOINT missing_source_charge;
SET LOCAL session_replication_role=replica;
DELETE FROM public.chip_ledger
 WHERE id=md5('played-spin-launch-source-ledger:1')::uuid;
SET LOCAL session_replication_role=origin;
DO $missing_source_charge_refused$
BEGIN
  IF COALESCE((public.fn_prove_played_spin_launch_recovery(
       '92010000-0000-0000-0000-000000000001')->>'ok')::boolean,false) THEN
    RAISE EXCEPTION 'FAIL played Spin recovery accepted an entitlement without its charge';
  END IF;
END;
$missing_source_charge_refused$;
ROLLBACK TO SAVEPOINT missing_source_charge;

SAVEPOINT underfunded;
SET LOCAL session_replication_role=replica;
UPDATE public.tournament_players SET chips=999
 WHERE tournament_id='92010000-0000-0000-0000-000000000001'
   AND user_id=md5('played-spin-launch-user:2')::uuid;
UPDATE public.table_seats SET stack=999
 WHERE table_id='92020000-0000-0000-0000-000000000001'
   AND user_id=md5('played-spin-launch-user:2')::uuid;
SET LOCAL session_replication_role=origin;
DO $underfunded_refused$
DECLARE
  v_completion jsonb;
BEGIN
  IF COALESCE((public.fn_prove_played_spin_launch_recovery(
       '92010000-0000-0000-0000-000000000001')->>'ok')::boolean,false) THEN
    RAISE EXCEPTION 'FAIL played Spin recovery accepted 2,999 of 3,000 chips';
  END IF;
  v_completion := public.fn_complete_tournament_launch_before_lease_generation(
    '92010000-0000-0000-0000-000000000001',
    '92040000-0000-4000-8000-000000000001'
  );
  IF COALESCE((v_completion->>'ok')::boolean,false)
     OR v_completion->>'reason' IS DISTINCT FROM 'launch_roster_unproven'
     OR (SELECT status FROM public.tournaments
          WHERE id='92010000-0000-0000-0000-000000000001') <> 'REGISTERING'
     OR (SELECT completed_at FROM public.tournament_launch_receipts
          WHERE tournament_id='92010000-0000-0000-0000-000000000001') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL completion did not transactionally recheck the 3,000-chip proof: %',
      v_completion;
  END IF;
END;
$underfunded_refused$;
ROLLBACK TO SAVEPOINT underfunded;

SAVEPOINT divergent_mirrors;
SET LOCAL session_replication_role=replica;
UPDATE public.table_seats SET stack=CASE seat_number WHEN 2 THEN 1000 ELSE 3000 END
 WHERE table_id='92020000-0000-0000-0000-000000000001'
   AND left_at IS NULL;
SET LOCAL session_replication_role=origin;
DO $divergent_mirrors_refused$
BEGIN
  IF COALESCE((public.fn_prove_played_spin_launch_recovery(
       '92010000-0000-0000-0000-000000000001')->>'ok')::boolean,false) THEN
    RAISE EXCEPTION
      'FAIL played Spin recovery accepted a 3,000-chip roster beside a 4,000-chip felt';
  END IF;
END;
$divergent_mirrors_refused$;
ROLLBACK TO SAVEPOINT divergent_mirrors;

SAVEPOINT divergent_player_mirrors;
SET LOCAL session_replication_role=replica;
UPDATE public.table_seats
   SET stack=CASE seat_number WHEN 2 THEN 2000 ELSE 1000 END
 WHERE table_id='92020000-0000-0000-0000-000000000001'
   AND left_at IS NULL;
SET LOCAL session_replication_role=origin;
DO $divergent_player_mirrors_refused$
BEGIN
  IF COALESCE((public.fn_prove_played_spin_launch_recovery(
       '92010000-0000-0000-0000-000000000001')->>'ok')::boolean,false) THEN
    RAISE EXCEPTION
      'FAIL played Spin recovery accepted equal totals on contradictory player mirrors';
  END IF;
END;
$divergent_player_mirrors_refused$;
ROLLBACK TO SAVEPOINT divergent_player_mirrors;

SAVEPOINT overminted_mirrors;
SET LOCAL session_replication_role=replica;
UPDATE public.tournament_players SET chips=CASE status WHEN 'playing' THEN 2000 ELSE 0 END
 WHERE tournament_id='92010000-0000-0000-0000-000000000001';
UPDATE public.table_seats SET stack=2000
 WHERE table_id='92020000-0000-0000-0000-000000000001'
   AND left_at IS NULL;
SET LOCAL session_replication_role=origin;
DO $overminted_mirrors_refused$
BEGIN
  IF COALESCE((public.fn_prove_played_spin_launch_recovery(
       '92010000-0000-0000-0000-000000000001')->>'ok')::boolean,false) THEN
    RAISE EXCEPTION
      'FAIL played Spin recovery accepted 4,000 chips without a funding receipt';
  END IF;
END;
$overminted_mirrors_refused$;
ROLLBACK TO SAVEPOINT overminted_mirrors;

SAVEPOINT second_bust_not_yet_vacated;
SET LOCAL session_replication_role=replica;
UPDATE public.tournament_players SET chips=0
 WHERE tournament_id='92010000-0000-0000-0000-000000000001'
   AND user_id=md5('played-spin-launch-user:2')::uuid;
UPDATE public.table_seats SET stack=0
 WHERE table_id='92020000-0000-0000-0000-000000000001'
   AND user_id=md5('played-spin-launch-user:2')::uuid;
UPDATE public.tournament_players SET chips=3000
 WHERE tournament_id='92010000-0000-0000-0000-000000000001'
   AND user_id=md5('played-spin-launch-user:3')::uuid;
UPDATE public.table_seats SET stack=3000
 WHERE table_id='92020000-0000-0000-0000-000000000001'
   AND user_id=md5('played-spin-launch-user:3')::uuid;
SET LOCAL session_replication_role=origin;
DO $second_bust_refused$
BEGIN
  IF COALESCE((public.fn_prove_played_spin_launch_recovery(
       '92010000-0000-0000-0000-000000000001')->>'ok')::boolean,false) THEN
    RAISE EXCEPTION
      'FAIL played Spin recovery accepted a second zero-stack survivor';
  END IF;
END;
$second_bust_refused$;
ROLLBACK TO SAVEPOINT second_bust_not_yet_vacated;

SAVEPOINT decided;
SET LOCAL session_replication_role=replica;
UPDATE public.table_seats
   SET left_at=transaction_timestamp(),status='left',stack=0
 WHERE table_id='92020000-0000-0000-0000-000000000001'
   AND user_id=md5('played-spin-launch-user:2')::uuid;
UPDATE public.tournament_players
   SET status='eliminated',table_id=NULL,seat_number=NULL,chips=0,
       eliminated_at=transaction_timestamp()
 WHERE tournament_id='92010000-0000-0000-0000-000000000001'
   AND user_id=md5('played-spin-launch-user:2')::uuid;
UPDATE public.tournament_players SET chips=3000
 WHERE tournament_id='92010000-0000-0000-0000-000000000001'
   AND user_id=md5('played-spin-launch-user:3')::uuid;
UPDATE public.table_seats SET stack=3000
 WHERE table_id='92020000-0000-0000-0000-000000000001'
   AND user_id=md5('played-spin-launch-user:3')::uuid;
UPDATE public.tables SET current_players=1
 WHERE id='92020000-0000-0000-0000-000000000001';
SET LOCAL session_replication_role=origin;
DO $decided_refused$
BEGIN
  IF COALESCE((public.fn_prove_played_spin_launch_recovery(
       '92010000-0000-0000-0000-000000000001')->>'ok')::boolean,false) THEN
    RAISE EXCEPTION 'FAIL played Spin recovery accepted a decided one-player game';
  END IF;
END;
$decided_refused$;
ROLLBACK TO SAVEPOINT decided;

SAVEPOINT heads_up_sng;
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET variant='sng',tournament_type='SNG',max_players=2
 WHERE id='92010000-0000-0000-0000-000000000001';
UPDATE public.tables SET max_players=2
 WHERE id='92020000-0000-0000-0000-000000000001';
SET LOCAL session_replication_role=origin;
DO $heads_up_refused$
BEGIN
  IF COALESCE((public.fn_prove_played_spin_launch_recovery(
       '92010000-0000-0000-0000-000000000001')->>'ok')::boolean,false) THEN
    RAISE EXCEPTION 'FAIL played Spin recovery accepted a Heads-Up SNG';
  END IF;
END;
$heads_up_refused$;
ROLLBACK TO SAVEPOINT heads_up_sng;

DO $completion_and_replay$
DECLARE
  v_complete jsonb;
  v_replay jsonb;
BEGIN
  v_complete := public.fn_complete_tournament_launch_before_lease_generation(
    '92010000-0000-0000-0000-000000000001',
    '92040000-0000-4000-8000-000000000001'
  );
  IF v_complete->>'ok' IS DISTINCT FROM 'true'
     OR v_complete->>'completed' IS DISTINCT FROM 'true'
     OR v_complete->>'replay' IS DISTINCT FROM 'false'
     OR v_complete->>'status' IS DISTINCT FROM 'RUNNING' THEN
    RAISE EXCEPTION 'FAIL exact played Spin launch did not complete: %',v_complete;
  END IF;

  v_replay := public.fn_complete_tournament_launch_before_lease_generation(
    '92010000-0000-0000-0000-000000000001',
    '92040000-0000-4000-8000-000000000001'
  );
  IF v_replay->>'ok' IS DISTINCT FROM 'true'
     OR v_replay->>'completed' IS DISTINCT FROM 'true'
     OR v_replay->>'replay' IS DISTINCT FROM 'true'
     OR v_replay->>'status' IS DISTINCT FROM 'RUNNING'
     OR (SELECT count(*) FROM public.tournament_players
          WHERE tournament_id='92010000-0000-0000-0000-000000000001'
            AND status='playing') <> 2
     OR (SELECT count(*) FROM public.tournament_players
          WHERE tournament_id='92010000-0000-0000-0000-000000000001'
            AND status='eliminated' AND chips=0) <> 1
     OR (SELECT count(*) FROM public.table_seats s
          JOIN public.tables t ON t.id=s.table_id
         WHERE t.tournament_id='92010000-0000-0000-0000-000000000001'
           AND s.left_at IS NULL) <> 2
     OR (SELECT count(*) FROM public.spin_reserve_ledger
          WHERE tournament_id='92010000-0000-0000-0000-000000000001'
            AND kind IN ('contribution','jackpot_draw')) <> 2
     OR (SELECT count(*) FROM public.chip_ledger
          WHERE tournament_id='92010000-0000-0000-0000-000000000001'
            AND category IN ('spin_entry','spin_prize')) <> 2 THEN
    RAISE EXCEPTION 'FAIL completed played Spin replay changed topology or money: %',v_replay;
  END IF;
END;
$completion_and_replay$;

DO $pass$
BEGIN
  RAISE EXCEPTION
    'AUDIT_TEST_PASS: one paid 3-max Spin with a committed draw, one persisted hand, one zero-stack eliminated/vacated player, two exact positive live survivors and exactly all 3,000 bought chips completed its launch exactly once; missing hand/draw/entitlement/source charge, 2,999 chips, divergent roster/felt totals, contradictory per-player mirrors, 4,000 unbacked chips, a second zero-stack bust, one survivor and Heads-Up SNG markers all failed closed; all probe work rolled back';
END;
$pass$;
