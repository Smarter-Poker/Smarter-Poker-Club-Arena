-- ═══════════════════════════════════════════════════════════════════════════════
-- THE NEW CHAIR FIRST, THEN THE OLD (Operation Table Stakes; 2026-09-05 00:10 UTC)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 20260905041000 exempted a within-game move from the four-table cap: a player
-- who already holds a live seat elsewhere in the destination's cluster is
-- changing chairs, not entering a game. It still refused, once a minute:
--
--     FOUR TABLE LIMIT: user a7bdfc35-… is already committed to 4 games
--
-- because fn_cash_seat_move_execute empties the OLD chair (left_at set) before
-- it writes the NEW one, so at the instant the cap trigger runs the player
-- holds no live seat in the game at all. The exemption could never be true.
--
-- The order is now: take the new chair (revive or insert), THEN zero and leave
-- the old one. Same sub-transaction, same exception block (a refused new
-- chair still undoes nothing on the old one because nothing was done to it
-- yet), same stack-to-zero-before-leave so trg_log_seat_stack_exit records no
-- exit for chips that went to another chair. A player is never seatless, even
-- inside the transaction.
--
-- Body is 20260905010500's (md5 1f11b108…) with the two UPDATEs moved and one
-- comment corrected; the assertion pins the order.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_execute(p_move_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  m record; src record; dst record; v_seat integer; v_new_id uuid; v_stack numeric;
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'frozen');
  END IF;
  SELECT * INTO m FROM public.cash_seat_moves WHERE id = p_move_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF m.state <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'reason', m.state); END IF;
  IF m.expires_at <= clock_timestamp() THEN
    UPDATE public.cash_seat_moves SET state = 'expired' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;

  SELECT * INTO src FROM public.table_seats
   WHERE table_id = m.from_table_id AND user_id = m.player_id AND left_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'player_not_seated' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'player_not_seated');
  END IF;

  SELECT * INTO dst FROM public.tables WHERE id = m.to_table_id FOR UPDATE;
  IF NOT FOUND OR dst.status NOT IN ('waiting', 'running', 'active') OR dst.lifecycle IN ('breaking', 'closed') THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_unavailable' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_unavailable');
  END IF;

  -- The lowest open, unreserved seat at the destination. A notified waitlist
  -- hold reserves one seat: leave that many free.
  SELECT gs INTO v_seat FROM generate_series(1, coalesce(dst.max_players, 9)) gs
   WHERE NOT EXISTS (SELECT 1 FROM public.table_seats ts
                      WHERE ts.table_id = dst.id AND ts.seat_number = gs AND ts.left_at IS NULL)
   ORDER BY gs LIMIT 1;
  IF v_seat IS NULL THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_full' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_full');
  END IF;

  v_stack := coalesce(src.stack, 0);

  -- 2 + 1 in ONE sub-transaction (new chair, then old): the old chair empties WITHOUT an exit of
  --    chips (stack to zero first, so trg_log_seat_stack_exit sees nothing
  --    leave), then the new chair takes the same player, the same chips and
  --    the SOURCE joined_at (1.3 s9.8 "join time travels"). If the new chair
  --    is refused, the exception block undoes the old chair's emptying too.
  BEGIN
    -- (table_id, seat_number) is unique across departed rows too, so a chair
    -- that has been sat in before is REVIVED, the way atomic_table_buyin
    -- does it; a never-used chair is inserted.
    UPDATE public.table_seats
       SET user_id = src.user_id, member_id = src.member_id, stack = v_stack,
           is_sitting_out = false, is_away = false, joined_at = src.joined_at,
           horse_id = src.horse_id, status = 'active', leave_pending = false,
           auto_rebuy = src.auto_rebuy, time_bank_remaining = src.time_bank_remaining,
           time_bank_uses_remaining = src.time_bank_uses_remaining, club_id = src.club_id,
           entry_hold = NULL, entry_post_agreed = src.entry_post_agreed, left_at = NULL
     WHERE table_id = dst.id AND seat_number = v_seat AND left_at IS NOT NULL
     RETURNING id INTO v_new_id;
    IF v_new_id IS NULL THEN
      INSERT INTO public.table_seats
        (table_id, seat_number, user_id, member_id, stack, is_sitting_out, is_away, joined_at,
         horse_id, status, leave_pending, auto_rebuy, time_bank_remaining, time_bank_uses_remaining,
         club_id, entry_hold, entry_post_agreed)
      VALUES
        (dst.id, v_seat, src.user_id, src.member_id, v_stack, false, false, src.joined_at,
         src.horse_id, 'active', false, src.auto_rebuy, src.time_bank_remaining, src.time_bank_uses_remaining,
         src.club_id, NULL, src.entry_post_agreed)
      RETURNING id INTO v_new_id;
    END IF;
    -- THE NEW CHAIR FIRST, THEN THE OLD (2026-09-05). This used to empty the
    -- old chair before taking the new one, so at the moment the destination
    -- row was written the player held NO live seat in the game, and the
    -- four-table cap read the move as entering a fifth game (a horse with
    -- three bookings and a tournament seat was refused every minute, and
    -- stayed on the breaking feeder). Taking the new chair first means the
    -- cap's move exemption (a live seat elsewhere in this cluster) holds,
    -- and the player is never, even inside this transaction, seatless.
    -- Stack to zero before leaving, as before: trg_log_seat_stack_exit
    -- must see no chips leave a chair whose chips went to another chair.
    UPDATE public.table_seats SET stack = 0 WHERE id = src.id;
    UPDATE public.table_seats SET left_at = clock_timestamp(), leave_pending = false, status = 'left'
     WHERE id = src.id;
  EXCEPTION WHEN OTHERS THEN
    -- A guard on the destination refused the chair (restriction, four-table
    -- limit, a race for the seat). The whole move is undone by this
    -- exception block's rollback of the sub-transaction: the player is
    -- still in the old chair with the old stack, and the plan is cancelled.
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = left(SQLERRM, 200) WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_refused', 'detail', left(SQLERRM, 200));
  END;

  -- 3. The chip-continuity session follows the player: baseline, clock and
  --    window untouched. This is the "cluster" scope Slice 0 promised.
  UPDATE public.cash_player_session
     SET scope_id = dst.id, table_id = dst.id
   WHERE player_id = m.player_id AND scope_type = 'table' AND scope_id = m.from_table_id AND closed_at IS NULL;

  -- 4. Counts and the record.
  UPDATE public.tables t SET current_players =
    (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = t.id AND ts.left_at IS NULL)
   WHERE t.id IN (m.from_table_id, m.to_table_id);
  UPDATE public.cash_seat_moves
     SET state = 'done', executed_at = clock_timestamp(), to_seat_number = v_seat
   WHERE id = m.id;
  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
  VALUES (m.game_id, m.to_table_id, 'seat_moved',
          jsonb_build_object('player_id', m.player_id, 'from_table_id', m.from_table_id,
                             'to_seat', v_seat, 'stack', v_stack, 'reason', m.reason));

  RETURN jsonb_build_object('ok', true, 'to_table_id', m.to_table_id, 'to_seat_number', v_seat, 'stack', v_stack);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_cash_seat_move_execute(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_move_execute(uuid) TO service_role;

DO $$
DECLARE src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'fn_cash_seat_move_execute' AND pronamespace = 'public'::regnamespace;
  IF position('RETURNING id INTO v_new_id;' in src) = 0
     OR position('SET left_at = clock_timestamp(), leave_pending = false, status = ''left''' in src)
        < position('RETURNING id INTO v_new_id;' in src) THEN
    RAISE EXCEPTION 'fn_cash_seat_move_execute still empties the old chair before taking the new one';
  END IF;
END $$;

COMMIT;
