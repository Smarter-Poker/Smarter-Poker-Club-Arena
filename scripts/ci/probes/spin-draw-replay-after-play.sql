-- Disposable PostgreSQL rehearsal only. A committed Spin draw is an immutable
-- receipt: launch retries after chips have moved (or a busted seat is vacated)
-- must verify that receipt without calling either lower money primitive. The
-- final PASS exception rolls back the fixture and every generated journal row.
BEGIN;

DO $fixture_guard$
BEGIN
  IF current_user <> 'postgres'
     OR to_regprocedure('public.fn_spin_draw_and_settle(uuid,jsonb)') IS NULL
     OR to_regclass('public.tournament_spin_settlement_cutover') IS NULL THEN
    RAISE EXCEPTION
      'Spin draw replay probe requires the disposable stage-one rehearsal database';
  END IF;
END;
$fixture_guard$;

SET LOCAL session_replication_role=replica;

INSERT INTO auth.users(id)
SELECT md5('spin-replay-user:'||g.i::text)::uuid
  FROM generate_series(1,3) g(i);

INSERT INTO public.profiles(id,username,display_name)
SELECT md5('spin-replay-user:'||g.i::text)::uuid,
       'spin_replay_'||g.i,'Spin Replay '||g.i
  FROM generate_series(1,3) g(i);

INSERT INTO public.clubs(id,name,owner_id,chip_treasury,spins_enabled)
VALUES (
  '91000000-0000-0000-0000-000000000001','Spin Replay Probe Club',
  md5('spin-replay-user:1')::uuid,1000,true);

INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance)
SELECT '91000000-0000-0000-0000-000000000001',
       md5('spin-replay-user:'||g.i::text)::uuid,
       CASE WHEN g.i=1 THEN 'owner' ELSE 'player' END,'active',100
  FROM generate_series(1,3) g(i);

INSERT INTO public.spin_bonus_pools(
  id,club_id,balance,total_deposited,total_drawn,spin_count,bonus_count,
  seeded_amount,ceiling_amount,highest_stake,surplus_returned,is_active,
  owner_kind,offered_max_stake,seed_returned_amount,required_seed_at_activation)
VALUES (
  '91030000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000001',
  1000,1000,0,0,0,0,10000,1,0,true,'club',1,0,0);

INSERT INTO public.tournaments(
  id,club_id,name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,
  start_time,status,current_players,max_players,min_players,starting_chips,
  table_size,prize_pool,payout_structure,spin_multiplier,spin_locked_tiers,
  synchronized_breaks)
VALUES
  ('91010000-0000-0000-0000-000000000001',
   '91000000-0000-0000-0000-000000000001','Spin Replay After Play',
   'NLH','spin','SPIN',1,0,now(),'REGISTERING',3,3,3,1000,3,3,
   '[{"place":1,"percentage":100}]',0,NULL,false),
  ('91010000-0000-0000-0000-000000000002',
   '91000000-0000-0000-0000-000000000001','Spin New Draw Negative Control',
   'NLH','spin','SPIN',1,0,now(),'REGISTERING',3,3,3,1000,3,3,
   '[{"place":1,"percentage":100}]',0,NULL,false);

INSERT INTO public.tables(
  id,club_id,name,game_type,game_variant,max_players,current_players,status,
  starting_chips,is_spins,tournament_id,lifecycle)
VALUES
  ('91020000-0000-0000-0000-000000000001',
   '91000000-0000-0000-0000-000000000001','Spin Replay Table',
   'tournament','nlh',3,3,'waiting',1000,true,
   '91010000-0000-0000-0000-000000000001','live'),
  ('91020000-0000-0000-0000-000000000002',
   '91000000-0000-0000-0000-000000000001','Spin Negative Table',
   'tournament','nlh',3,3,'waiting',1000,true,
   '91010000-0000-0000-0000-000000000002','live');

INSERT INTO public.tournament_players(
  id,tournament_id,user_id,username,chips,status,table_id,seat_number,club_id)
SELECT md5('spin-replay-player:'||event.i||':'||g.i)::uuid,
       CASE event.i WHEN 1 THEN '91010000-0000-0000-0000-000000000001'::uuid
                    ELSE '91010000-0000-0000-0000-000000000002'::uuid END,
       md5('spin-replay-user:'||g.i::text)::uuid,
       'Spin Replay '||g.i,
       CASE WHEN event.i=1 THEN 1000
            WHEN g.i=1 THEN 0 WHEN g.i=2 THEN 1000 ELSE 2000 END,
       'playing',
       CASE event.i WHEN 1 THEN '91020000-0000-0000-0000-000000000001'::uuid
                    ELSE '91020000-0000-0000-0000-000000000002'::uuid END,
       g.i,'91000000-0000-0000-0000-000000000001'
  FROM generate_series(1,2) event(i)
 CROSS JOIN generate_series(1,3) g(i);

INSERT INTO public.table_seats(
  id,table_id,seat_number,user_id,stack,status,left_at,leave_pending,
  is_sitting_out,is_away,club_id)
SELECT md5('spin-replay-seat:'||event.i||':'||g.i)::uuid,
       CASE event.i WHEN 1 THEN '91020000-0000-0000-0000-000000000001'::uuid
                    ELSE '91020000-0000-0000-0000-000000000002'::uuid END,
       g.i,md5('spin-replay-user:'||g.i::text)::uuid,
       CASE WHEN event.i=1 THEN 1000
            WHEN g.i=1 THEN 0 WHEN g.i=2 THEN 1000 ELSE 2000 END,
       'active',NULL,false,false,false,
       '91000000-0000-0000-0000-000000000001'
  FROM generate_series(1,2) event(i)
 CROSS JOIN generate_series(1,3) g(i);

INSERT INTO public.tournament_escrow(
  tournament_id,gross_in,fee_entries_in,satellite_fee_in,bounty_in,overlay_in,
  satellite_in,prize_out,bounty_out,fee_out,refund_prize,refund_bounty,
  refund_fee,reserve_out,reserve_in,prize_balance,bounty_balance,fee_balance,
  opened_from,opened_at,updated_at,enforced)
VALUES
  ('91010000-0000-0000-0000-000000000001',3,0,0,0,0,0,0,0,0,0,0,0,0,0,3,0,0,
   'spin-draw-replay-probe',now(),now(),true),
  ('91010000-0000-0000-0000-000000000002',3,0,0,0,0,0,0,0,0,0,0,0,0,0,3,0,0,
   'spin-draw-replay-negative',now(),now(),true);

INSERT INTO public.wallet_transactions(
  id,user_id,wallet_type,amount,type,category,description,related_entity_id,
  balance_after)
SELECT md5('spin-replay-wallet:'||event.i||':'||g.i)::uuid,
       md5('spin-replay-user:'||g.i::text)::uuid,'PLAYER',1,'debit',
       'tournament_buyin','Spin replay probe buy-in',
       CASE event.i WHEN 1 THEN '91010000-0000-0000-0000-000000000001'::uuid
                    ELSE '91010000-0000-0000-0000-000000000002'::uuid END,
       99
  FROM generate_series(1,2) event(i)
 CROSS JOIN generate_series(1,3) g(i);

CREATE TEMP TABLE spin_replay_results(
  phase text PRIMARY KEY,
  receipt jsonb NOT NULL,
  durable_state jsonb
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.spin_replay_state(p_tournament_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'public','pg_temp'
AS $state$
  SELECT jsonb_build_object(
    'pool',(SELECT jsonb_build_object(
      'balance',p.balance,'total_deposited',p.total_deposited,
      'total_drawn',p.total_drawn,'spin_count',p.spin_count,
      'bonus_count',p.bonus_count,'seeded_amount',p.seeded_amount,
      'seed_returned_amount',p.seed_returned_amount)
      FROM public.spin_bonus_pools p
      WHERE p.id='91030000-0000-0000-0000-000000000001'),
    'reserve',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.kind,r.id)
      FROM public.spin_reserve_ledger r WHERE r.tournament_id=p_tournament_id),
    'journal',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.category,l.id)
      FROM public.chip_ledger l WHERE l.tournament_id=p_tournament_id
        AND l.category IN ('spin_entry','spin_prize')),
    'rake',(SELECT jsonb_agg(to_jsonb(rr) ORDER BY rr.id)
      FROM public.rake_records rr WHERE rr.tournament_id=p_tournament_id),
    'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e
      WHERE e.tournament_id=p_tournament_id),
    'contract',(SELECT jsonb_build_object(
      'spin_multiplier',t.spin_multiplier,'prize_pool',t.prize_pool,
      'spin_locked_tiers',t.spin_locked_tiers)
      FROM public.tournaments t WHERE t.id=p_tournament_id));
$state$;

SET LOCAL session_replication_role=origin;

-- Fail after the native entry, rake, draw journal, reserve receipt and escrow
-- writes. The failure must erase all of them before the same event is retried.
CREATE FUNCTION pg_temp.spin_replay_fail_after_draw()
RETURNS trigger LANGUAGE plpgsql AS $fault$
BEGIN
  IF NEW.tournament_id='91010000-0000-0000-0000-000000000001'
     AND NEW.kind='jackpot_draw' THEN
    IF (SELECT count(*) FROM public.spin_reserve_ledger
          WHERE tournament_id=NEW.tournament_id) <> 2
       OR (SELECT count(*) FROM public.chip_ledger
          WHERE tournament_id=NEW.tournament_id
            AND category IN ('spin_entry','spin_prize')) <> 2
       OR (SELECT count(*) FROM public.rake_records
          WHERE tournament_id=NEW.tournament_id) <> 1
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_escrow e
          WHERE e.tournament_id=NEW.tournament_id
            AND e.reserve_out=2.76 AND e.reserve_in=-NEW.amount
            AND e.fee_entries_in=.24 AND e.prize_balance=-NEW.amount) THEN
      RAISE EXCEPTION 'FAIL native draw fault did not follow all money writes';
    END IF;
    RAISE EXCEPTION 'expected native draw receipt fault' USING ERRCODE='ZX001';
  END IF;
  RETURN NEW;
END;
$fault$;

CREATE TRIGGER zzzzzz_spin_replay_fault
AFTER INSERT ON public.spin_reserve_ledger
FOR EACH ROW EXECUTE FUNCTION pg_temp.spin_replay_fail_after_draw();

DO $rollback_proof$
DECLARE
  v_before jsonb;
  v_failed boolean:=false;
BEGIN
  v_before:=pg_temp.spin_replay_state(
    '91010000-0000-0000-0000-000000000001');
  BEGIN
    PERFORM public.fn_spin_draw_and_settle(
      '91010000-0000-0000-0000-000000000001',
      '[{"multiplier":2,"freq":4809776,"reserveThresholdX":0},{"multiplier":3,"freq":3930716,"reserveThresholdX":0},{"multiplier":4,"freq":900000,"reserveThresholdX":0},{"multiplier":5,"freq":250000,"reserveThresholdX":0},{"multiplier":10,"freq":100000,"reserveThresholdX":0},{"multiplier":25,"freq":7500,"reserveThresholdX":0},{"multiplier":50,"freq":1000,"reserveThresholdX":0},{"multiplier":100,"freq":1008,"reserveThresholdX":1.5}]'::jsonb);
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN
    v_failed:=true;
  END;
  IF NOT v_failed OR pg_temp.spin_replay_state(
       '91010000-0000-0000-0000-000000000001') IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'FAIL native Spin failure retained partial financial state';
  END IF;
END;
$rollback_proof$;

DROP TRIGGER zzzzzz_spin_replay_fault ON public.spin_reserve_ledger;
DROP FUNCTION pg_temp.spin_replay_fail_after_draw();

INSERT INTO spin_replay_results(phase,receipt)
SELECT 'initial',public.fn_spin_draw_and_settle(
    '91010000-0000-0000-0000-000000000001',
    '[{"multiplier":2,"freq":4809776,"reserveThresholdX":0},{"multiplier":3,"freq":3930716,"reserveThresholdX":0},{"multiplier":4,"freq":900000,"reserveThresholdX":0},{"multiplier":5,"freq":250000,"reserveThresholdX":0},{"multiplier":10,"freq":100000,"reserveThresholdX":0},{"multiplier":25,"freq":7500,"reserveThresholdX":0},{"multiplier":50,"freq":1000,"reserveThresholdX":0},{"multiplier":100,"freq":1008,"reserveThresholdX":1.5}]'::jsonb);
UPDATE spin_replay_results
   SET durable_state=pg_temp.spin_replay_state(
     '91010000-0000-0000-0000-000000000001')
 WHERE phase='initial';

DO $initial_proof$
DECLARE
  v_receipt jsonb;
BEGIN
  SELECT receipt INTO v_receipt FROM spin_replay_results WHERE phase='initial';
  IF v_receipt->>'ok' IS DISTINCT FROM 'true'
     OR (v_receipt->>'multiplier')::numeric NOT IN (2,3,4,5,10,25,50,100)
     OR (v_receipt->>'prize_pool')::numeric
          <> (v_receipt->>'multiplier')::numeric
     OR (v_receipt->>'entry_amount')::numeric <> 2.76
     OR (v_receipt->>'house_rake')::numeric <> .24
     OR v_receipt->>'entry_reserve_id' IS NULL
     OR v_receipt->>'entry_journal_id' IS NULL
     OR v_receipt->>'draw_reserve_id' IS NULL
     OR v_receipt->>'draw_journal_id' IS NULL
     OR (SELECT count(*) FROM public.spin_reserve_ledger
          WHERE tournament_id='91010000-0000-0000-0000-000000000001') <> 2
     OR (SELECT count(*) FROM public.spin_reserve_ledger
          WHERE tournament_id='91010000-0000-0000-0000-000000000001'
            AND kind='contribution') <> 1
     OR (SELECT count(*) FROM public.spin_reserve_ledger
          WHERE tournament_id='91010000-0000-0000-0000-000000000001'
            AND kind='jackpot_draw') <> 1
     OR (SELECT count(*) FROM public.chip_ledger
          WHERE tournament_id='91010000-0000-0000-0000-000000000001'
            AND category IN ('spin_entry','spin_prize')) <> 2
     OR (SELECT count(*) FROM public.rake_records
          WHERE tournament_id='91010000-0000-0000-0000-000000000001') <> 1
     OR (SELECT count(*) FROM public.rake_records
          WHERE tournament_id='91010000-0000-0000-0000-000000000001'
            AND source='fn_spin_book_entry') <> 1
     OR (SELECT count(*) FROM public.rake_records
          WHERE tournament_id='91010000-0000-0000-0000-000000000001'
            AND source='fn_spin_settle_game') <> 0
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_escrow e
        WHERE e.tournament_id='91010000-0000-0000-0000-000000000001'
          AND e.reserve_out=2.76
          AND e.reserve_in=(v_receipt->>'prize_pool')::numeric
          AND e.fee_entries_in=.24
          AND e.prize_balance=(v_receipt->>'prize_pool')::numeric)
     OR NOT EXISTS (
       SELECT 1 FROM public.spin_bonus_pools p
        WHERE p.id='91030000-0000-0000-0000-000000000001'
          AND p.balance=1002.76-(v_receipt->>'prize_pool')::numeric
          AND p.total_deposited=1002.76
          AND p.total_drawn=(v_receipt->>'prize_pool')::numeric
          AND p.spin_count=1)
     OR NOT EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id='91010000-0000-0000-0000-000000000001'
          AND t.spin_multiplier=(v_receipt->>'multiplier')::numeric
          AND t.prize_pool=(v_receipt->>'prize_pool')::numeric
          AND t.spin_locked_tiers='[]'::jsonb) THEN
    RAISE EXCEPTION 'FAIL initial Spin draw evidence is incomplete: %',v_receipt;
  END IF;
END;
$initial_proof$;

SET LOCAL session_replication_role=replica;
UPDATE public.table_seats s
   SET stack=CASE s.seat_number WHEN 1 THEN 0 WHEN 2 THEN 1000 ELSE 2000 END
 WHERE s.table_id='91020000-0000-0000-0000-000000000001';
UPDATE public.tournament_players tp
   SET chips=CASE tp.seat_number WHEN 1 THEN 0 WHEN 2 THEN 1000 ELSE 2000 END
 WHERE tp.tournament_id='91010000-0000-0000-0000-000000000001';
SET LOCAL session_replication_role=origin;

INSERT INTO spin_replay_results(phase,receipt)
SELECT 'redistributed',public.fn_spin_draw_and_settle(
    '91010000-0000-0000-0000-000000000001',
    '[{"multiplier":999,"freq":1,"reserveThresholdX":0}]'::jsonb);
UPDATE spin_replay_results
   SET durable_state=pg_temp.spin_replay_state(
     '91010000-0000-0000-0000-000000000001')
 WHERE phase='redistributed';

SET LOCAL session_replication_role=replica;
UPDATE public.table_seats
   SET left_at=now(),status='left'
 WHERE table_id='91020000-0000-0000-0000-000000000001' AND seat_number=1;
UPDATE public.tournament_players
   SET status='eliminated',table_id=NULL,seat_number=NULL,eliminated_at=now()
 WHERE tournament_id='91010000-0000-0000-0000-000000000001'
   AND user_id=md5('spin-replay-user:1')::uuid;
UPDATE public.tables SET current_players=2
 WHERE id='91020000-0000-0000-0000-000000000001';
SET LOCAL session_replication_role=origin;

INSERT INTO spin_replay_results(phase,receipt)
SELECT 'vacated',public.fn_spin_draw_and_settle(
    '91010000-0000-0000-0000-000000000001',
    NULL);
UPDATE spin_replay_results
   SET durable_state=pg_temp.spin_replay_state(
     '91010000-0000-0000-0000-000000000001')
 WHERE phase='vacated';

DO $replay_proof$
DECLARE
  v_first spin_replay_results%ROWTYPE;
  v_replay spin_replay_results%ROWTYPE;
  v_key text;
BEGIN
  SELECT * INTO v_first FROM spin_replay_results WHERE phase='initial';
  FOR v_replay IN SELECT * FROM spin_replay_results WHERE phase<>'initial' ORDER BY phase LOOP
    FOREACH v_key IN ARRAY ARRAY[
      'entry_reserve_id','entry_journal_id','draw_reserve_id','draw_journal_id',
      'multiplier','prize_pool','entry_amount','draw_amount','house_rake','pool_id'
    ] LOOP
      IF v_replay.receipt->>v_key IS DISTINCT FROM v_first.receipt->>v_key THEN
        RAISE EXCEPTION 'FAIL % replay changed receipt key % (% versus %)',
          v_replay.phase,v_key,v_replay.receipt->>v_key,v_first.receipt->>v_key;
      END IF;
    END LOOP;
    IF v_replay.durable_state IS DISTINCT FROM v_first.durable_state THEN
      RAISE EXCEPTION 'FAIL % replay changed financial or contract state: before %, after %',
        v_replay.phase,v_first.durable_state,v_replay.durable_state;
    END IF;
  END LOOP;
END;
$replay_proof$;

DO $new_draw_negative_control$
DECLARE
  v_state text;
BEGIN
  BEGIN
    PERFORM public.fn_spin_draw_and_settle(
      '91010000-0000-0000-0000-000000000002',
      '[{"multiplier":2,"freq":1,"reserveThresholdX":0}]'::jsonb);
    RAISE EXCEPTION 'Spin authority accepted caller-defined economics';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM public.fn_spin_draw_and_settle(
      '91010000-0000-0000-0000-000000000002',
      '[{"multiplier":2,"freq":4809776,"reserveThresholdX":0},{"multiplier":3,"freq":3930716,"reserveThresholdX":0},{"multiplier":4,"freq":900000,"reserveThresholdX":0},{"multiplier":5,"freq":250000,"reserveThresholdX":0},{"multiplier":10,"freq":100000,"reserveThresholdX":0},{"multiplier":25,"freq":7500,"reserveThresholdX":0},{"multiplier":50,"freq":1000,"reserveThresholdX":0},{"multiplier":100,"freq":1008,"reserveThresholdX":1.5}]'::jsonb);
    RAISE EXCEPTION 'new Spin draw accepted a played starting-stack distribution';
  EXCEPTION
    WHEN SQLSTATE '55000' THEN v_state:='55000';
  END;
  IF v_state IS DISTINCT FROM '55000'
     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger
                 WHERE tournament_id='91010000-0000-0000-0000-000000000002')
     OR EXISTS (SELECT 1 FROM public.chip_ledger
                 WHERE tournament_id='91010000-0000-0000-0000-000000000002'
                   AND category IN ('spin_entry','spin_prize')) THEN
    RAISE EXCEPTION 'FAIL a brand-new draw did not fail closed before money';
  END IF;
END;
$new_draw_negative_control$;

DO $pass$
BEGIN
  RAISE EXCEPTION
    'AUDIT_TEST_PASS: Spin entry, rake, draw journals, reserve receipts and escrow rolled back after an injected native receipt fault; the same event retried successfully once; Spin draw replay ignored drifted and null caller ladders after commit, accepted conserved played and vacated-seat states, returned the same four immutable evidence ids, changed no financial/contract state, called no lower money path, rejected caller-defined economics for a new draw, and a new draw still required three exact starting stacks; all probe work rolled back';
END;
$pass$;
