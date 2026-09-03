-- ═══════════════════════════════════════════════════════════════════════════
--  THE SPIN TREASURY IS FUNDED WHEN THE LAST SEAT IS PAID (Dan, 2026-09-01)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, verbatim: "after all 3 buy ins are paid for, rake is taken out and sent
-- to the rake treasury, and all remaining funds from the buy in goes to the
-- [spins] treasury, in real time as soon as the 3rd buy in is paid for."
--
-- It did not work that way. At buy-in the money went wallet -> ledger debit and
-- `tournaments.prize_pool += buy_in`, and NOTHING reached either treasury. Both
-- the rake record and the reserve-pool contribution were written later, by
-- fn_spin_settle_game, which the engine calls at start() immediately after the
-- draw. Close in wall-clock time, and structurally fragile: the funding of the
-- treasury was a downstream consequence of the DRAW succeeding. When settle
-- failed its three attempts the game still ran and still paid, and the treasury
-- had no record of either side of it -- 112 Spins on 2026-08-31, 5,737.00 of
-- prizes out of a pool that had never been credited the buy-ins that funded
-- them.
--
-- Now the entry is booked by the seat that fills the board, before any wheel
-- turns, and it cannot be lost by anything that happens afterwards.
--
-- WHERE THE HOOK LIVES, AND WHY THERE. fn_sync_seat_first_player_count is the
-- one function BOTH seating paths call - fn_take_seat_and_buy_in for a human,
-- fn_seat_horse_in_seat_first_game for a horse. Hooking the booking to the seat
-- COUNT rather than to either caller means a horse completing the board funds
-- the treasury exactly as a human does, which is the law (CLAUDE.md 10.5), and
-- a third seating path written later inherits it without knowing it exists.
--
-- IDEMPOTENT BY THE LEDGER, not by a flag: a contribution row for the
-- tournament is the record that the entry is booked. The counter function is
-- called many times per game and retries itself on deadlock.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.fn_spin_book_entry(uuid);
--   -- and re-apply the previous fn_sync_seat_first_player_count and
--   -- fn_spin_settle_game from 20260831185816_ca_zero_drift_phase2_suspense_drain.sql

CREATE OR REPLACE FUNCTION public.fn_spin_book_entry(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t         record;
  v_owner     uuid;
  v_seats     integer;
  v_collected numeric;
  v_rake      numeric;
  v_reserve_in numeric;
  v_balance   numeric;
BEGIN
  SELECT t.id, t.club_id, t.buy_in_amount, t.max_players, t.variant
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;

  IF NOT FOUND OR COALESCE(v_t.variant,'') <> 'spin' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_spin');
  END IF;
  IF v_t.club_id IS NULL OR COALESCE(v_t.buy_in_amount, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_inputs');
  END IF;

  -- Already booked. The ledger row is the record; there is no flag to drift.
  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
              WHERE tournament_id = p_tournament_id AND kind = 'contribution') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_booked');
  END IF;

  v_owner := public.fn_spin_reserve_pool(v_t.club_id);
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_reserve_owner');
  END IF;

  -- SPIN_SEATS by definition, and the same 3 the engine settles on. Not
  -- current_players, which drains as players bust.
  v_seats      := GREATEST(COALESCE(v_t.max_players, 3), 1);
  v_collected  := round(v_t.buy_in_amount * v_seats, 2);
  v_rake       := round(v_collected * public.fn_spin_rake_rate(v_t.buy_in_amount), 2);
  v_reserve_in := round(v_collected - v_rake, 2);

  PERFORM pg_advisory_xact_lock(hashtextextended('spin_entry', 0), hashtextextended(p_tournament_id::text, 0));

  -- Re-check under the lock. Two seats can complete a board in the same
  -- instant when a horse and a human race for the last chair.
  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
              WHERE tournament_id = p_tournament_id AND kind = 'contribution') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_booked');
  END IF;

  PERFORM set_config('app.ledger_category', 'spin_entry', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);

  UPDATE public.spin_bonus_pools
     SET balance         = balance + v_reserve_in,
         total_deposited = total_deposited + v_reserve_in,
         spin_count      = spin_count + 1,
         highest_stake   = GREATEST(highest_stake, v_t.buy_in_amount),
         updated_at      = now()
   WHERE club_id = v_owner
   RETURNING balance INTO v_balance;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_pool_row', 'owner_id', v_owner);
  END IF;

  INSERT INTO public.spin_reserve_ledger
    (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
  VALUES (v_owner, p_tournament_id, 'contribution', v_reserve_in, v_balance,
          NULL, v_t.buy_in_amount, v_seats, v_rake,
          CASE WHEN v_owner = v_t.club_id
               THEN 'buy-ins less fixed rake, booked when the last seat was paid'
               ELSE format('buy-ins less fixed rake, booked when the last seat was paid (club %s)', v_t.club_id)
          END);

  IF v_rake > 0 THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_rake, v_collected, v_seats, 0, true,
            p_tournament_id, 'fn_spin_book_entry',
            jsonb_build_object('kind','spin_rake','buy_in',v_t.buy_in_amount,
                               'rake_rate', public.fn_spin_rake_rate(v_t.buy_in_amount),
                               'booked_at','entry','reserve_owner',v_owner));
  END IF;

  RETURN jsonb_build_object('ok', true, 'collected', v_collected,
    'house_rake', v_rake, 'reserve_in', v_reserve_in,
    'balance', v_balance, 'owner_id', v_owner, 'seats', v_seats);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_spin_book_entry(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_book_entry(uuid) TO service_role;

COMMENT ON FUNCTION public.fn_spin_book_entry(uuid) IS
  'Books a Spin entry the moment its last seat is paid: rake to rake_records, '
  'the remainder into the club reserve pool. Idempotent on the contribution '
  'ledger row. Called from fn_sync_seat_first_player_count so a horse funds the '
  'treasury exactly as a human does.';

DO $$
DECLARE v_ok boolean;
BEGIN
  IF has_function_privilege('anon', 'public.fn_spin_book_entry(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_spin_book_entry(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_spin_book_entry is reachable from a browser role';
  END IF;
END $$;;
