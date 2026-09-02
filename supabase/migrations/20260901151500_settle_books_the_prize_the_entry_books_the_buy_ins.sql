-- ═══════════════════════════════════════════════════════════════════════════
--  SETTLE BOOKS THE PRIZE; THE ENTRY BOOKS THE BUY-INS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- With fn_spin_book_entry funding the treasury when the last seat is paid, two
-- things in fn_spin_settle_game have to change or the fix does nothing:
--
--   1. ITS IDEMPOTENCY GUARD. It returned `already_settled` when EITHER a
--      contribution OR a jackpot_draw row existed. The entry now writes the
--      contribution row before the wheel turns, so the old guard would see it
--      and skip the prize booking entirely - the pool would take the buy-ins
--      and never record the payout. The guard keys on `jackpot_draw` alone,
--      which is the row settle is actually responsible for.
--
--   2. ITS CONTRIBUTION AND RAKE BLOCKS. Both are now conditional on not
--      already being booked. They are kept rather than deleted because
--      fn_spin_sweep_unbooked calls this function to repair games that predate
--      the entry hook, and those have no contribution row. One function, two
--      entry points, no double-booking either way.
--
-- Nothing else moves: the shortfall rule, the seed repayment instalment and
-- every ledger category stay exactly as they were.
--
-- ROLLBACK: re-apply 20260831185816_ca_zero_drift_phase2_suspense_drain.sql

CREATE OR REPLACE FUNCTION public.fn_spin_settle_game(
  p_tournament_id uuid, p_club_id uuid, p_buy_in numeric,
  p_seats integer, p_multiplier numeric, p_rake_rate numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_collected numeric; v_rake numeric; v_reserve_in numeric;
  v_prize numeric; v_bal numeric; v_available numeric;
  v_shortfall numeric := 0; v_drawn numeric;
  v_owner uuid; v_kind text; v_seed numeric; v_wallet text;
  v_floor numeric; v_instalment numeric := 0;
  v_seed_returned numeric := 0; v_wallet_after numeric := NULL;
  v_booked_mult numeric; v_booked_drawn numeric;
  v_entry_booked boolean;
  v_rake_booked boolean;
BEGIN
  IF COALESCE(p_buy_in,0) <= 0 OR COALESCE(p_seats,0) <= 0 OR COALESCE(p_multiplier,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_inputs');
  END IF;

  v_owner := public.fn_spin_reserve_pool(p_club_id);

  SELECT balance INTO v_bal
    FROM public.spin_bonus_pools WHERE club_id = v_owner FOR UPDATE;

  -- THE PRIZE IS WHAT THIS FUNCTION OWNS. A contribution row on its own means
  -- the entry was booked when the last seat was paid and the prize still is
  -- not; only a jackpot_draw row means settled.
  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
             WHERE tournament_id = p_tournament_id AND kind = 'jackpot_draw') THEN
    SELECT l.multiplier, -l.amount INTO v_booked_mult, v_booked_drawn
      FROM public.spin_reserve_ledger l
     WHERE l.tournament_id = p_tournament_id AND l.kind = 'jackpot_draw'
     ORDER BY l.created_at ASC LIMIT 1;
    RETURN jsonb_build_object('ok', true, 'reason', 'already_settled',
      'multiplier', v_booked_mult, 'pool_covered', v_booked_drawn);
  END IF;

  v_collected  := round(p_buy_in * p_seats, 2);
  v_rake       := round(v_collected * COALESCE(p_rake_rate, 0.08), 2);
  v_reserve_in := round(v_collected - v_rake, 2);
  v_prize      := round(p_buy_in * p_multiplier, 2);

  v_entry_booked := EXISTS (SELECT 1 FROM public.spin_reserve_ledger
                             WHERE tournament_id = p_tournament_id AND kind = 'contribution');
  v_rake_booked  := EXISTS (SELECT 1 FROM public.rake_records
                             WHERE tournament_id = p_tournament_id
                               AND source IN ('fn_spin_book_entry','fn_spin_settle_game'));

  IF NOT v_entry_booked THEN
    -- ZERO-DRIFT phase 2: reserve intake = spin_entry vs the tournament.
    PERFORM set_config('app.ledger_category', 'spin_entry', true);
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);

    UPDATE public.spin_bonus_pools
       SET balance = balance + v_reserve_in,
           total_deposited = total_deposited + v_reserve_in,
           spin_count = spin_count + 1,
           highest_stake = GREATEST(highest_stake, p_buy_in),
           updated_at = now()
     WHERE club_id = v_owner RETURNING balance INTO v_available;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'spin pool row missing for owner % settling tournament %',
        v_owner, p_tournament_id;
    END IF;

    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
    VALUES (v_owner, p_tournament_id, 'contribution', v_reserve_in, v_available,
            p_multiplier, p_buy_in, p_seats, v_rake,
            CASE WHEN v_owner = p_club_id THEN 'buy-ins less fixed rake'
                 ELSE format('buy-ins less fixed rake (club %s)', p_club_id) END);
  ELSE
    -- Already funded at entry. Read where the pool actually stands.
    SELECT balance INTO v_available
      FROM public.spin_bonus_pools WHERE club_id = v_owner;
    IF v_available IS NULL THEN
      RAISE EXCEPTION 'spin pool row missing for owner % settling tournament %',
        v_owner, p_tournament_id;
    END IF;
  END IF;

  IF v_prize > v_available THEN
    v_shortfall := round(v_prize - v_available, 2);
    v_drawn := v_available;
  ELSE
    v_drawn := v_prize;
  END IF;

  -- ZERO-DRIFT phase 2: the draw funds the tournament's prize pool.
  PERFORM set_config('app.ledger_category', 'spin_prize', true);

  UPDATE public.spin_bonus_pools
     SET balance = balance - v_drawn,
         total_drawn = total_drawn + v_drawn,
         bonus_count = bonus_count + CASE WHEN p_multiplier >= 10 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE club_id = v_owner RETURNING balance INTO v_bal;

  INSERT INTO public.spin_reserve_ledger
    (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
  VALUES (v_owner, p_tournament_id, 'jackpot_draw', -v_drawn, v_bal,
          p_multiplier, p_buy_in, p_seats, v_rake,
          CASE WHEN v_shortfall > 0
               THEN format('prize pool (pool covered %s of %s)', v_drawn, v_prize)
               ELSE 'prize pool' END);

  IF v_shortfall > 0 THEN
    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, note)
    VALUES (v_owner, p_tournament_id, 'adjustment', 0, v_bal,
            p_multiplier, p_buy_in, p_seats,
            format('SHORTFALL %s covered by operator - pool was too thin for a %sx. Seed it.',
                   v_shortfall, p_multiplier));
  END IF;

  IF v_rake > 0 AND p_club_id IS NOT NULL AND NOT v_rake_booked THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, p_club_id, v_rake, v_collected, p_seats, 0, true,
            p_tournament_id, 'fn_spin_settle_game',
            jsonb_build_object('kind','spin_rake','multiplier',p_multiplier,
                               'buy_in',p_buy_in,'rake_rate',p_rake_rate,
                               'shortfall',v_shortfall,'reserve_owner',v_owner));
  END IF;

  -- THE REPAYMENT PLAN - one instalment per settle, at most.
  SELECT seeded_amount, seed_source_wallet, owner_kind, required_seed_at_activation
    INTO v_seed, v_wallet, v_kind, v_floor
    FROM public.spin_bonus_pools WHERE club_id = v_owner;

  v_instalment := public.fn_spin_seed_instalment(v_bal, COALESCE(v_seed,0), COALESCE(v_floor,0));

  IF v_instalment > 0 AND v_wallet IS NOT NULL THEN
    PERFORM set_config('app.ledger_category', 'treasury_transfer', true);
    PERFORM set_config('app.ledger_counterparty',
      CASE WHEN v_kind = 'union' THEN 'union_wallet' ELSE 'club_treasury' END, true);
    PERFORM set_config('app.ledger_counterparty_entity', v_owner::text, true);
    PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);

    v_wallet_after := public.fn_spin_move_owner_wallet(v_owner, v_kind, v_wallet, v_instalment);

    IF v_wallet_after IS NOT NULL THEN
      UPDATE public.spin_bonus_pools
         SET balance              = balance - v_instalment,
             seeded_amount        = seeded_amount - v_instalment,
             seed_returned_amount = seed_returned_amount + v_instalment,
             seed_returned_at     = now(),
             required_seed_at_activation =
               CASE WHEN seeded_amount - v_instalment <= 0 THEN 0
                    ELSE required_seed_at_activation END,
             updated_at           = now()
       WHERE club_id = v_owner RETURNING balance INTO v_bal;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'spin pool row vanished for owner % after repaying % to %',
          v_owner, v_instalment, v_wallet;
      END IF;

      v_seed_returned := v_instalment;

      INSERT INTO public.spin_reserve_ledger
        (club_id, tournament_id, kind, amount, balance_after, note)
      VALUES (v_owner, p_tournament_id, 'seed_return', -v_instalment, v_bal,
              format('seed instalment to %s %s - 50%% of %s above a floor of %s; %s still owed',
                     v_kind, v_wallet, round(v_bal + v_instalment - v_floor, 2), v_floor,
                     GREATEST(COALESCE(v_seed,0) - v_instalment, 0)));
    END IF;

    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
    PERFORM set_config('app.ledger_autoskip_clubs', '', true);
  END IF;

  RETURN jsonb_build_object('ok', true, 'collected', v_collected,
    'house_rake', v_rake, 'reserve_in', v_reserve_in, 'prize_pool', v_prize,
    'pool_covered', v_drawn, 'operator_shortfall', v_shortfall,
    'balance', v_bal, 'seed_returned', v_seed_returned,
    'entry_booked_at_seat', v_entry_booked,
    'seed_outstanding', GREATEST(COALESCE(v_seed,0) - v_seed_returned, 0),
    'owner_id', v_owner, 'source_wallet_after', v_wallet_after);
END;
$function$;

-- ── The hook: the seat that fills the board funds the treasury ──────────────
CREATE OR REPLACE FUNCTION public.fn_sync_seat_first_player_count(p_tournament_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_table      uuid;
  v_seats      integer := 0;
  v_seat_first boolean := false;
  v_is_spin    boolean := false;
  v_cap        integer := 0;
  v_attempt    integer := 0;
BEGIN
  SELECT (COALESCE(t.variant, '') IN ('spin', 'sng') OR COALESCE(t.max_players, 0) <= 2),
         COALESCE(t.variant, '') = 'spin',
         COALESCE(t.max_players, 0)
    INTO v_seat_first, v_is_spin, v_cap
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;

  <<retry>>
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      v_table := public.fn_tournament_primary_table(p_tournament_id);

      IF v_table IS NULL THEN
        IF COALESCE(v_seat_first, false) THEN
          SELECT count(*) INTO v_seats
            FROM public.table_seats s
            JOIN public.tables tb ON tb.id = s.table_id
           WHERE tb.tournament_id = p_tournament_id
             AND s.left_at IS NULL;
          UPDATE public.tournaments SET current_players = v_seats WHERE id = p_tournament_id;
          RETURN v_seats;
        END IF;
        RETURN NULL;
      END IF;

      SELECT count(*) INTO v_seats
        FROM public.table_seats
       WHERE table_id = v_table AND left_at IS NULL;

      UPDATE public.tables SET current_players = v_seats WHERE id = v_table;

      IF COALESCE(v_seat_first, false) THEN
        UPDATE public.tournaments SET current_players = v_seats WHERE id = p_tournament_id;
      END IF;

      /* THE LAST SEAT FUNDS THE TREASURY (Dan, 2026-09-01). Both seating
         paths - fn_take_seat_and_buy_in for a human, fn_seat_horse_in_seat_
         first_game for a horse - land here, so this is the one place that
         knows the board just filled, whoever filled it. fn_spin_book_entry is
         idempotent on its own ledger row, and its failure is reported rather
         than raised: a booking problem must never cost a player their seat. */
      IF v_is_spin AND v_cap > 0 AND v_seats >= v_cap THEN
        BEGIN
          PERFORM public.fn_spin_book_entry(p_tournament_id);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'fn_spin_book_entry failed for % : %', p_tournament_id, SQLERRM;
        END;
      END IF;

      RETURN v_seats;

    EXCEPTION
      WHEN deadlock_detected OR lock_not_available THEN
        IF v_attempt >= 3 THEN
          RAISE;
        END IF;
        PERFORM pg_sleep(0.05 * v_attempt);
    END;
  END LOOP;
END;
$function$;

DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_spin_settle_game';
  IF position('kind = ''jackpot_draw''' in v_src) = 0 THEN
    RAISE EXCEPTION 'fn_spin_settle_game idempotency guard is not keyed on jackpot_draw';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_sync_seat_first_player_count';
  IF position('fn_spin_book_entry' in v_src) = 0 THEN
    RAISE EXCEPTION 'the seat counter does not book the spin entry';
  END IF;
END $$;;

-- ── Grants restated with the declarations above ────────────────────────────
-- Both functions are engine-only: nothing in the browser calls either, and
-- neither can know who is asking (no auth.uid()). Production already holds
-- exactly these grants; they are written here because a migration that
-- re-declares a SECURITY DEFINER writer and does not say who may run it is
-- indistinguishable from one that opened it.
REVOKE ALL ON FUNCTION public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric) TO service_role;
REVOKE ALL ON FUNCTION public.fn_sync_seat_first_player_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_seat_first_player_count(uuid) TO service_role;
