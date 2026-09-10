-- 20260910024034_settle_the_friday_night_feature_satellite_heads_up.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS DOES, AND WHY (2026-09-10, CLAUDE.md 10.9 - the money is mine to
-- settle when the five conditions hold; they do):
--
-- Friday Night Feature Satellite Heads-Up, 9fee70de-c692-48fb-a423-98d730ab02bc,
-- union-hosted (club fade0000-...0001), buy-in 20.00 (19.00 + 1.00 fee), two
-- entrants, pool 38.00 in escrow, rake 2.00 expected. The engine watched the
-- heads-up end: a2bd256e-014c-4504-97c7-6bc43242fef1 busted and is recorded
-- eliminated in position 2; 9da2d0b7-436d-4e47-826e-4c30077428a4 was the last
-- seat with chips (600 on the felt) and never received the winner row,
-- because the atomic finish that would have written it was refused:
--
--   FOUR TABLE LIMIT: user 9da2d0b7-... is already committed to 5 games and
--   may not enter another
--
-- Cause and fix are in 20260910022325_a_finished_game_is_not_a_game_and_a_cap_
-- is_not_a_failure (the cap counted the winner's own seat at this satellite,
-- and delivery tried a seat instead of choosing cash). The wallet the
-- settlement pays into was fixed in 20260910023919_the_entry_is_charged_to_
-- the_wallet_the_entry_is_stamped_with: both entrants were charged at the
-- fade0000 wallet and are now stamped fade0000, so the prize returns to the
-- wallet the buy-in left.
--
-- The five conditions:
--   1. READ: the buy-in ledger rows, the felt (600 vs 0), the engine-recorded
--      elimination of position 2, the entitlement plan (position 1:
--      seat_or_cash 30.00 ticket / 0.00 remainder; position 2: cash 8.00).
--   2. NOBODY PAID TWICE: everything goes through
--      fn_settle_satellite_finish_atomic, whose obligations, payouts and
--      batches are keyed and idempotent, and which writes nothing unless its
--      own post-condition (fn_check_atomic_satellite_finish) passes.
--   3. NOTHING TAKEN BACK: two credits, no debits.
--   4. PROVED ROLLED BACK: probed three times in a self-aborting DO block
--      (11.5). The numbers asserted below are the numbers the probe returned.
--   5. THE PARAGRAPH: 9da2d0b7 (a horse; 10.5 - owed exactly what a human is
--      owed) won the heads-up and is owed the 30.00 target entry. He holds
--      four live games, so the seat cannot be given; the frozen value is paid
--      as 30.00 chips to his fade0000 wallet (delivery cash, reason
--      four_table_cap). a2bd256e finished second and is owed the 8.00
--      remainder of the 38.00 pool, paid to his fade0000 wallet. 2.00 rake is
--      attributed to the union. The escrow closes at 0.00 / 0.00 / 0.00 and the
--      event is COMPLETED.
--
-- Source 'recovery' is the engine's own recovery re-drive authority
-- (ca_settle_sources), which is what this migration is: the same call the
-- engine made, made again after its cause was fixed.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_sat   uuid := '9fee70de-c692-48fb-a423-98d730ab02bc';
  v_win   uuid := '9da2d0b7-436d-4e47-826e-4c30077428a4';
  v_snd   uuid := 'a2bd256e-014c-4504-97c7-6bc43242fef1';
  v_club  uuid := 'fade0000-0000-0000-0000-000000000001';
  v_status text; v_rows int;
  v_w1_before numeric; v_w2_before numeric; v_w1_after numeric; v_w2_after numeric;
  v_rake jsonb; v_r jsonb; v_o1 jsonb; v_o2 jsonb;
  v_escrow record;
BEGIN
  PERFORM set_config('app.money_path','fn_settle_satellite_finish_atomic',true);

  -- Pre-conditions: the board is exactly what was probed.
  SELECT status INTO v_status FROM public.tournaments WHERE id = v_sat FOR UPDATE;
  IF v_status <> 'RUNNING' THEN
    RAISE EXCEPTION 'satellite is % - expected RUNNING; the board moved, nothing written', v_status;
  END IF;
  IF (SELECT count(*) FROM public.tournament_players WHERE tournament_id = v_sat) <> 2
     OR NOT EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id = v_sat AND user_id = v_snd AND status = 'eliminated' AND "position" = 2)
     OR NOT EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id = v_sat AND user_id = v_win AND status = 'playing' AND "position" IS NULL) THEN
    RAISE EXCEPTION 'standings are not the probed standings; nothing written';
  END IF;
  IF (SELECT string_agg(club_id::text, ',' ORDER BY user_id) FROM public.tournament_players WHERE tournament_id = v_sat)
     <> v_club::text || ',' || v_club::text THEN
    RAISE EXCEPTION 'entrants are not stamped with the charged wallet %; nothing written', v_club;
  END IF;
  IF (SELECT round(prize_pool,2) FROM public.tournaments WHERE id = v_sat) <> 38.00 THEN
    RAISE EXCEPTION 'pool is not 38.00; nothing written';
  END IF;
  IF COALESCE((SELECT stack FROM public.table_seats s JOIN public.tables t ON t.id = s.table_id
                WHERE t.tournament_id = v_sat AND s.user_id = v_win AND s.left_at IS NULL LIMIT 1), 0) <= 0 THEN
    RAISE EXCEPTION 'the winner does not hold the last stack on the felt; nothing written';
  END IF;

  SELECT chip_balance INTO v_w1_before FROM public.club_members WHERE user_id = v_win AND club_id = v_club;
  SELECT chip_balance INTO v_w2_before FROM public.club_members WHERE user_id = v_snd AND club_id = v_club;

  -- The engine's finish, replayed: COMPLETING, the winner row it could not write, rake, atomic settle.
  UPDATE public.tournaments SET status = 'COMPLETING' WHERE id = v_sat AND status = 'RUNNING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'COMPLETING CAS changed % rows', v_rows; END IF;

  UPDATE public.tournament_players
     SET status = 'winner', "position" = 1, eliminated_at = COALESCE(eliminated_at, now())
   WHERE tournament_id = v_sat AND user_id = v_win AND status = 'playing';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'winner row CAS changed % rows', v_rows; END IF;

  v_rake := public.fn_settle_tournament_rake(v_sat, 'recovery');
  IF COALESCE((v_rake->>'ok')::boolean, false) IS NOT TRUE
     OR round((v_rake->>'amount')::numeric, 2) <> 2.00 THEN
    RAISE EXCEPTION 'rake did not settle as probed: %', v_rake;
  END IF;

  v_r := public.fn_settle_satellite_finish_atomic(v_sat, 'recovery');
  IF COALESCE((v_r->>'ok')::boolean, false) IS NOT TRUE
     OR COALESCE((v_r->>'settled')::boolean, false) IS NOT TRUE
     OR round((v_r->>'amount_settled')::numeric, 2) <> 38.00
     OR (v_r->>'winner_user_id')::uuid <> v_win THEN
    RAISE EXCEPTION 'atomic satellite finish did not settle as probed: %', v_r;
  END IF;
  SELECT o INTO v_o1 FROM jsonb_array_elements(v_r->'outcomes') o WHERE (o->>'position')::int = 1;
  SELECT o INTO v_o2 FROM jsonb_array_elements(v_r->'outcomes') o WHERE (o->>'position')::int = 2;
  IF v_o1 IS NULL OR v_o2 IS NULL
     OR (v_o1->>'user_id')::uuid <> v_win OR v_o1->>'ticket_delivery' <> 'cash'
     OR v_o1->>'delivery_reason' <> 'four_table_cap'
     OR round((v_o1->>'ticket_value')::numeric, 2) <> 30.00
     OR (v_o2->>'user_id')::uuid <> v_snd OR v_o2->>'ticket_delivery' <> 'cash'
     OR round((v_o2->>'remainder_value')::numeric, 2) <> 8.00 THEN
    RAISE EXCEPTION 'outcomes are not the probed outcomes: %', v_r->'outcomes';
  END IF;

  -- Post-conditions: the money landed where the buy-in left, the escrow is empty, the event is over.
  SELECT status INTO v_status FROM public.tournaments WHERE id = v_sat;
  IF v_status <> 'COMPLETED' THEN RAISE EXCEPTION 'status is % after settle', v_status; END IF;
  SELECT chip_balance INTO v_w1_after FROM public.club_members WHERE user_id = v_win AND club_id = v_club;
  SELECT chip_balance INTO v_w2_after FROM public.club_members WHERE user_id = v_snd AND club_id = v_club;
  IF round(v_w1_after - v_w1_before, 2) <> 30.00 OR round(v_w2_after - v_w2_before, 2) <> 8.00 THEN
    RAISE EXCEPTION 'wallet deltas are % / %, expected 30.00 / 8.00 at club %',
      round(v_w1_after - v_w1_before, 2), round(v_w2_after - v_w2_before, 2), v_club;
  END IF;
  SELECT * INTO v_escrow FROM public.tournament_escrow WHERE tournament_id = v_sat;
  IF v_escrow.tournament_id IS NULL
     OR abs(v_escrow.prize_balance) > 0.005 OR abs(v_escrow.bounty_balance) > 0.005 OR abs(v_escrow.fee_balance) > 0.005 THEN
    RAISE EXCEPTION 'escrow is not empty after settle: % / % / %', v_escrow.prize_balance, v_escrow.bounty_balance, v_escrow.fee_balance;
  END IF;
  IF (SELECT count(*) FROM public.tournament_obligations WHERE tournament_id = v_sat AND settled_at IS NOT NULL
        AND round(amount_paid, 2) = round(amount_owed, 2)) <> 2 THEN
    RAISE EXCEPTION 'expected exactly two settled obligations';
  END IF;

  -- The incident this settles, resolved with its cause.
  UPDATE public.ca_drift_incidents
     SET status = 'resolved',
         resolved_at = now(),
         root_cause = 'fn_concurrent_game_load counted the winner''s own seat at the COMPLETING satellite, and fn_deliver_satellite_ticket_exact attempted a target seat without asking whether the four-table cap allowed it; trg_enforce_booking_game_cap refused the seat and the atomic settlement returned retryable=false. Fixed at both lines in migration 20260910022325.',
         correction_ref = 'migration 20260910024034_settle_the_friday_night_feature_satellite_heads_up',
         resolution = 'Settled through fn_settle_satellite_finish_atomic after the fix: 30.00 to 9da2d0b7 (position 1, cash, four_table_cap), 8.00 to a2bd256e (position 2), 2.00 rake to the union, escrow 0.00, event COMPLETED. Both credits to the fade0000 wallets the buy-ins were charged at (migration 20260910023919).'
   WHERE id = '2688ef4c-302d-4ef3-84a1-4924e2df9b0d' AND status = 'open';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'incident 2688ef4c was not open to resolve (% rows)', v_rows; END IF;

  RAISE NOTICE 'Friday Night Feature Satellite Heads-Up settled: 30.00 -> %, 8.00 -> %, rake %, batch %',
    v_win, v_snd, v_rake->>'amount', v_r->>'plan_fingerprint';
END
$body$;

COMMIT;
