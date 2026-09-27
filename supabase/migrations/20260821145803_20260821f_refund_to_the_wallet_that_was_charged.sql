-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821145803 "20260821f_refund_to_the_wallet_that_was_charged"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9966fb16f1adaca098aa6a67efbe208c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- 20260821f: the seat refund must return chips to the LEDGER THAT WAS CHARGED.
--
-- Caught in live testing of 20260821e: the buy-in runs through
-- atomic_deduct_wallet_and_log, which debits the player's CLUB wallet
-- (club_members.chip_balance, club resolved by fn_player_home_club) — verified
-- in chip_transactions: 'tournament_buyin 2.00' against club a0000000. The
-- refund used credit_player_wallet, which writes the separate `wallets` PLAYER
-- row. That would have taken chips out of one ledger and put them back into
-- another: the player's club balance short by the buy-in forever, and chips
-- conjured into a wallet that never paid. It also assigned a void-returning
-- function to a boolean, so the call errored out (22P02) and no refund
-- happened at all — the failure that exposed the ledger mismatch.
--
-- Refunds now credit the same club wallet via fn_add_chips, using the same
-- fn_player_home_club(uid, NULL) resolution the debit used.
--
-- Idempotency: the function requires a LIVE seat and deletes the registration,
-- so a second call returns 'not_seated' and pays nothing.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS public.fn_leave_seat_and_refund(uuid);

CREATE OR REPLACE FUNCTION public.fn_leave_seat_and_refund(p_table_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_tbl record; v_t record; v_split record;
  v_bounty boolean; v_seat integer; v_taken integer; v_club uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_leave_seat_and_refund requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT id, tournament_id INTO v_tbl FROM public.tables WHERE id = p_table_id FOR UPDATE;
  IF NOT FOUND OR v_tbl.tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  SELECT id, status, variant, max_players, buy_in_amount, buy_in_fee,
         bounty_amount, is_bounty, is_pko, is_mystery_bounty, club_id, name
    INTO v_t FROM public.tournaments WHERE id = v_tbl.tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
  END IF;

  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_already_started');
  END IF;

  SELECT seat_number INTO v_seat FROM public.table_seats
   WHERE table_id = p_table_id AND user_id = v_uid AND left_at IS NULL LIMIT 1;
  IF v_seat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_seated');
  END IF;

  v_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
              OR COALESCE(v_t.is_mystery_bounty, false);

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_bounty);

  UPDATE public.table_seats SET left_at = now(), is_sitting_out = false
   WHERE table_id = p_table_id AND user_id = v_uid AND left_at IS NULL;

  DELETE FROM public.tournament_players
   WHERE tournament_id = v_t.id AND user_id = v_uid;

  UPDATE public.tournaments
     SET current_players = GREATEST(COALESCE(current_players, 0) - 1, 0),
         prize_pool = GREATEST(COALESCE(prize_pool, 0) - v_split.prize, 0),
         bounty_pool = GREATEST(COALESCE(bounty_pool, 0) - v_split.bounty, 0),
         total_rake = GREATEST(COALESCE(total_rake, 0) - v_split.rake, 0)
   WHERE id = v_t.id;

  DELETE FROM public.rake_records
   WHERE tournament_id = v_t.id
     AND source = 'fn_register_for_tournament'
     AND (metadata->>'user_id') = v_uid::text;

  IF COALESCE(v_split.charge, 0) > 0 THEN
    -- SAME resolution the debit used (fn_register_for_tournament calls
    -- atomic_deduct_wallet_and_log with p_table_id NULL).
    v_club := public.fn_player_home_club(v_uid, NULL);
    IF v_club IS NULL THEN
      RAISE EXCEPTION 'seat refund could not resolve the club wallet that was charged';
    END IF;
    PERFORM public.fn_add_chips(v_uid, v_club, v_split.charge);
    INSERT INTO public.chip_transactions (club_id, to_user_id, amount, transaction_type, notes)
    VALUES (v_club, v_uid, v_split.charge, 'tournament_refund',
            'Seat released: ' || COALESCE(v_t.name, 'game') || ' (full refund)');
    PERFORM public.log_wallet_transaction(
      v_uid, 'PLAYER', v_split.charge, 'credit', 'tournament_refund',
      'Seat released: ' || COALESCE(v_t.name, 'game') || ' (full refund)',
      NULL, NULL, v_t.id);
  END IF;

  SELECT count(*) INTO v_taken FROM public.table_seats
   WHERE table_id = p_table_id AND left_at IS NULL;
  UPDATE public.tables SET current_players = v_taken WHERE id = p_table_id;

  RETURN jsonb_build_object('ok', true, 'refunded', COALESCE(v_split.charge, 0),
    'seat_number', v_seat, 'seats_taken', v_taken, 'club_id', v_club);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_leave_seat_and_refund(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.fn_leave_seat_and_refund(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_leave_seat_and_refund(uuid) TO service_role;
