-- 20260905101732_the_spin_books_its_entry_with_the_escrow_lock_first.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard Phase 5 gate, 2026-09-05 10:17 UTC):
--
-- spin_entry_threw:9cd44071... (critical, 09:05:13 UTC): fn_spin_book_entry
-- raised 40P01 deadlock detected. Read back: the third buy-in landed at
-- 09:05:13.973, the entry was booked on the retry at 09:05:22, the spin drew,
-- paid and closed at 0.00 exact. No chip moved wrongly; a player's action hit
-- a deadlock. The same error is on record one to three times a day since
-- 09-02, before any escrow trigger existed, so the cycle is older than Phase
-- 5, but Phase 5 put the escrow row in it:
--
--   registration: wallet debit -> escrow row (FOR UPDATE, wallet_tx trigger)
--                 -> seat count fills -> fn_spin_book_entry -> advisory lock
--   the sweep:    fn_spin_book_entry -> advisory lock -> reserve pool
--                 -> spin_entry leg -> escrow row (FOR UPDATE, reserve trigger)
--
-- Two orders. fn_spin_book_entry now takes the escrow row before the advisory
-- lock, so every path holds them in one order (escrow, advisory, pool). A
-- spin with no escrow row yet locks nothing there and opens at first sight
-- as before. The function body is the live definition with that one line
-- added; ACLs restated in full.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_spin_book_entry(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_owner uuid; v_seats integer;
  v_collected numeric; v_rake numeric; v_reserve_in numeric; v_balance numeric;
  v_contrib jsonb; v_per_head numeric; v_seated integer;
BEGIN
  SELECT t.id, t.club_id, t.buy_in_amount, t.max_players, t.variant
    INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id;

  IF NOT FOUND OR COALESCE(v_t.variant,'') <> 'spin' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_spin');
  END IF;
  IF v_t.club_id IS NULL OR COALESCE(v_t.buy_in_amount, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_inputs');
  END IF;

  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
              WHERE tournament_id = p_tournament_id AND kind = 'contribution') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_booked');
  END IF;

  -- CHIP STANDARD (2026-09-05): THE ESCROW ROW FIRST. A registration holds the
  -- spin's tournament_escrow row (its wallet debit's trigger) and then, when
  -- the seat count fills, books the entry here and waits for the advisory
  -- lock; the unbooked sweep holds the advisory lock and then reaches the
  -- same escrow row through the reserve leg. Two orders, one deadlock
  -- (40P01, one to three a day since 09-02; spin_entry_threw incidents).
  -- Taking the escrow row before the advisory lock gives every path one
  -- order: escrow, advisory, reserve pool. A spin with no row yet locks
  -- nothing here and opens at first sight as before.
  PERFORM 1 FROM public.tournament_escrow WHERE tournament_id = p_tournament_id FOR UPDATE;

  PERFORM pg_advisory_xact_lock(hashtextextended('spin_entry:' || p_tournament_id::text, 0));

  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
              WHERE tournament_id = p_tournament_id AND kind = 'contribution') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_booked');
  END IF;

  v_owner := public.fn_spin_reserve_pool(v_t.club_id);
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_reserve_owner');
  END IF;

  v_seats      := GREATEST(COALESCE(v_t.max_players, 3), 1);
  v_collected  := round(v_t.buy_in_amount * v_seats, 2);
  v_rake       := round(v_collected * public.fn_spin_rake_rate(v_t.buy_in_amount), 2);
  v_reserve_in := round(v_collected - v_rake, 2);

  PERFORM set_config('app.ledger_category', 'spin_entry', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);

  UPDATE public.spin_bonus_pools
     SET balance = balance + v_reserve_in,
         total_deposited = total_deposited + v_reserve_in,
         spin_count = spin_count + 1,
         highest_stake = GREATEST(highest_stake, v_t.buy_in_amount),
         updated_at = now()
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
    -- NO DIRECT TREASURY CREDIT. atomic_distribute_rake consumes this
    -- rake_records row and moves the chips to treasury and union. Crediting
    -- clubs.chip_treasury here as well double-credited every spin.
    SELECT jsonb_object_agg(tp.user_id::text, v_t.buy_in_amount), count(*)
      INTO v_contrib, v_seated
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id;

    v_per_head := CASE WHEN COALESCE(v_seated,0) > 0
                       THEN round(v_rake / v_seated, 4) ELSE NULL END;

    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source,
       player_contributions, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_rake, v_collected,
            COALESCE(v_seated, v_seats), 0, true,
            p_tournament_id, 'fn_spin_book_entry',
            v_contrib,
            jsonb_build_object('kind','spin_rake','buy_in',v_t.buy_in_amount,
                               'rake_rate', public.fn_spin_rake_rate(v_t.buy_in_amount),
                               'booked_at','entry','reserve_owner',v_owner,
                               'treasury_credited', false,
                               'distributed_by','atomic_distribute_rake',
                               'rake_per_player', v_per_head,
                               'seats_attributed', COALESCE(v_seated,0)));
  END IF;

  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);

  RETURN jsonb_build_object('ok', true, 'collected', v_collected,
    'house_rake', v_rake, 'reserve_in', v_reserve_in,
    'balance', v_balance, 'owner_id', v_owner, 'seats', v_seats,
    'treasury_credited', false,
    'rake_per_player', v_per_head, 'seats_attributed', COALESCE(v_seated,0));
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_spin_book_entry(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_book_entry(uuid) TO service_role;

UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(),
       correction_ref = 'migration 20260905101732_the_spin_books_its_entry_with_the_escrow_lock_first',
       root_cause = 'a registration held the spin''s escrow row and waited for the spin_entry advisory lock while the unbooked sweep held the advisory lock and reached the escrow row through the reserve leg: two lock orders, 40P01. The retry booked the entry nine seconds later and the spin closed at 0.00 exact',
       resolution = 'fn_spin_book_entry takes the escrow row before the advisory lock, so every path holds them in one order'
 WHERE dedupe_key = 'spin_entry_threw:9cd44071-56d0-4162-aae0-0bdeaa581ed1' AND status = 'open';

DO $$
DECLARE v_src text; v_a int; v_b int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_spin_book_entry';
  v_a := position('FROM public.tournament_escrow WHERE tournament_id = p_tournament_id FOR UPDATE' IN v_src);
  v_b := position('pg_advisory_xact_lock(hashtextextended(''spin_entry:''' IN v_src);
  IF v_a = 0 OR v_b = 0 OR v_a > v_b THEN
    RAISE EXCEPTION 'the escrow row is not taken before the advisory lock (% / %)', v_a, v_b;
  END IF;
END $$;

COMMIT;
