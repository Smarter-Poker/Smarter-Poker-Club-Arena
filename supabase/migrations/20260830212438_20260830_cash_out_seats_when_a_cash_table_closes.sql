-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830212438; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Closing a CASH table released every seat and kept the chips.
--
-- fn_on_table_status_change releases a table's seats when it goes terminal, and
-- it is careful about tournaments: a close under a live tournament is refused,
-- logged to engine_recovery_events with the application_name, db_role and txid
-- of whoever did it. For a CASH table it simply does
--
--     UPDATE table_seats SET left_at = ... WHERE table_id = NEW.id AND left_at IS NULL
--
-- with no cash-out, so every seated player's stack stops existing. fn_clear_table_seats
-- has the same shape.
--
-- MEASURED, not theorised. fn_unaccounted_seat_exits over the last 24 hours
-- returns 1,036 exits worth 432,100.90 chips, every one of them on a cash table
-- and every one exit_kind='left'. Traced one end to end: a player bought in for
-- 9,750.00 at 10:37, was seated with 9,928.50 at 10:53, had the seat released,
-- and never received a credit — their next credit is a different cash-out from
-- a different buy-in three hours later.
--
-- This function is the missing half. It is deliberately a separate, callable
-- unit rather than more logic inside the trigger, so the same refund can be
-- reused by fn_clear_table_seats and tested on its own.
--
-- It follows atomic_table_cashout exactly, because that is the path a normal
-- cash-out already takes and the two must not disagree:
--   * chips return to the club the SEAT belonged to, falling back to the
--     player's home club; the membership is re-created if it has gone, so
--     chips are never diverted to a shared wallet and never stranded;
--   * club_members.chip_balance is the live pool. public.wallets is NOT —
--     it has been frozen since 2026-08-21 with 732,591,994.33 chips in it and
--     nothing reads it;
--   * a wallet_transactions row with category 'cashout' is what
--     fn_unaccounted_seat_exits looks for, so a refunded seat stops being
--     reported as a leak.
--
-- HORSES ARE PLAYERS: there is no is_horse branch here. A horse seated at a
-- closing table gets its chips back exactly as a human does.

CREATE OR REPLACE FUNCTION public.fn_cashout_seats_for_closing_table(
  p_table_id uuid,
  p_reason   text DEFAULT 'table closed'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_is_tournament boolean;
  v_seat          record;
  v_club          uuid;
  v_new_balance   numeric;
  v_count         int := 0;
  v_total         numeric := 0;
BEGIN
  IF p_table_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'p_table_id required');
  END IF;

  SELECT (t.tournament_id IS NOT NULL) INTO v_is_tournament
    FROM public.tables t WHERE t.id = p_table_id;

  IF v_is_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  -- A tournament stack is not wallet money; it is settled by the payout
  -- structure, never handed back at a table close.
  IF v_is_tournament THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'tournament_table');
  END IF;

  FOR v_seat IN
    SELECT id, user_id, stack, club_id
      FROM public.table_seats
     WHERE table_id = p_table_id
       AND left_at IS NULL
       AND user_id IS NOT NULL
       AND COALESCE(stack, 0) > 0
     FOR UPDATE
  LOOP
    v_club := v_seat.club_id;
    IF v_club IS NULL THEN
      v_club := public.fn_player_home_club(v_seat.user_id, NULL);
    END IF;

    -- No resolvable wallet is a reason to STOP, not to release the seat and
    -- lose the chips. Leaving it seated keeps the money visible and the seat
    -- recoverable; the caller reports and a human settles it.
    IF v_club IS NULL THEN
      CONTINUE;
    END IF;

    PERFORM public.fn_ensure_club_wallet(v_seat.user_id, v_club);

    /* Name the movement for fn_club_members_ledger_writer so this lands in
       chip_ledger as a cashout rather than an anonymous adjustment. */
    PERFORM set_config('app.ledger_category', 'cashout', true);

    UPDATE public.club_members
       SET chip_balance = COALESCE(chip_balance, 0) + v_seat.stack,
           updated_at   = NOW()
     WHERE user_id = v_seat.user_id AND club_id = v_club
     RETURNING chip_balance INTO v_new_balance;

    PERFORM set_config('app.ledger_category', '', true);

    INSERT INTO public.wallet_transactions
      (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (v_seat.user_id, 'PLAYER', 'credit', v_seat.stack, 'cashout',
            'Cash-out from table (' || COALESCE(p_reason, 'table closed') || ')',
            p_table_id, v_new_balance);

    -- Zero the stack before the seat is released so the seat-exit audit sees a
    -- settled seat rather than another non-zero exit to investigate.
    UPDATE public.table_seats
       SET stack = 0
     WHERE id = v_seat.id;

    v_count := v_count + 1;
    v_total := v_total + v_seat.stack;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'players_paid', v_count, 'chips_returned', v_total);
END;
$fn$;
