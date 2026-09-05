-- 20260905064237_horses_use_the_seat_change_and_presence_follows_the_move.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- TWO THINGS THE MUST-MOVE LOBBY LEFT OWED (docs/changelog/2026-09-05-the-must-move-lobby.md).
--
-- == 1. A HORSE CAN ASK FOR A SEAT CHANGE (CLAUDE.md 10.5) ====================
--
-- `fn_cash_seat_change_request` reads `auth.uid()` and nothing else, so it is
-- reachable only from a browser. Every player on a feeder table gets the Seat
-- Change button; the horses - who are most of the feeder population - could
-- not press it, because the engine authenticates as service_role and
-- auth.uid() is NULL there. That is the exact shape 10.5 is about: a feature a
-- human gets and a horse does not, by construction rather than by decision.
--
-- The door now takes an explicit p_user_id, and HONOURS IT ONLY FOR THE
-- ENGINE. `fn_caller_is_engine()` is the estate's single definition of that
-- question (20260828090000): service_role, or no PostgREST request context at
-- all. For a browser the parameter is ignored outright - not merely unset -
-- so a signed-in player cannot spend somebody else's once-per-stay seat
-- change by passing their id, and the human path is byte-for-byte the
-- behaviour it had before this migration.
--
-- REPLACED, NOT OVERLOADED. Postgres cannot add a parameter with CREATE OR
-- REPLACE, and a 3-arg overload beside the 2-arg original would make the
-- client's own two-argument call AMBIGUOUS and fail every human seat change.
-- So the 2-arg function is dropped and re-created with three parameters, the
-- third defaulted: PostgREST resolves `{p_game_id, p_to_table_id}` to it
-- exactly as before.
--
-- == 2. PRESENCE FOLLOWS THE PLAYER ACROSS A MOVE ============================
--
-- Both executors wrote the arriving chair with `is_sitting_out = false,
-- sit_out_at = NULL`. A player who was SITTING OUT at the feeder therefore
-- arrived at the new table ACTIVE, and was dealt into the very next hand they
-- had chosen not to play - then auto-folded, took the strikes, and paid the
-- blinds for it. `is_away` was already carried; the sit-out was not, and it is
-- the half a player can see.
--
-- Carried from the source chair now, both for an ordinary move and for both
-- sides of a swap. Nothing else about a move changes: the stack, the session,
-- the entry hold and `entry_post_agreed` are untouched, so what a move does to
-- chips and to entry state is exactly what it did yesterday.
--
-- The rest of presence - connectivity, the strike count, the away-blind budget
-- and the sit-out's own clock - lives in the engine's DisconnectEngine, not on
-- the seat row, and is handed over in process (server/src/engine/SeatMovePresence.ts).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- ROLLBACK (Tier 3 - a function signature changes):
--   DROP FUNCTION IF EXISTS public.fn_cash_seat_change_request(uuid, uuid, uuid);
--   then re-create the two-argument body and the two executors from
--   supabase/migrations/20260905060000_the_must_move_lobby_a_seat_change_and_the_order_you_joined.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. THE DOOR: the same door, and a horse may knock on it
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.fn_cash_seat_change_request(uuid, uuid);

CREATE FUNCTION public.fn_cash_seat_change_request(
  p_game_id uuid,
  p_to_table_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  -- THE ONLY LINE THAT DIFFERS FROM THE HUMAN DOOR. A browser is its own
  -- auth.uid() and nothing else; the engine, and only the engine, may name the
  -- player it is acting for. Everything below this line is unchanged.
  v_uid uuid := CASE WHEN public.fn_caller_is_engine() THEN coalesce(p_user_id, auth.uid())
                     ELSE auth.uid() END;
  g record; me record; dst record; ro record; q record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: sign in first' USING ERRCODE = '28000';
  END IF;
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: the platform is on its maintenance break' USING ERRCODE = 'check_violation';
  END IF;
  -- The same lock the tick takes: a request and a tick never plan the same
  -- chair twice.
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND: %', p_game_id; END IF;
  IF NOT g.must_move THEN
    RAISE EXCEPTION 'SEAT_CHANGE_MANUAL_GAME: a manual table has no seat change' USING ERRCODE = 'check_violation';
  END IF;

  SELECT ts.table_id, ts.seat_number, ts.stack, ts.leave_pending, t.role, t.main_index, t.lifecycle, t.name
    INTO me
    FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
   WHERE ts.user_id = v_uid AND ts.left_at IS NULL AND t.cluster_id = g.id AND t.lifecycle <> 'closed'
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_IN_GAME: you are not seated in this game' USING ERRCODE = 'check_violation';
  END IF;
  IF me.role = 'main' AND me.main_index = 1 THEN
    RAISE EXCEPTION 'SEAT_CHANGE_NOT_FROM_MAIN: the main game has no seat change' USING ERRCODE = 'check_violation';
  END IF;
  IF me.lifecycle = 'breaking' THEN
    RAISE EXCEPTION 'SEAT_CHANGE_TABLE_CLOSING: this table is closing and the game is already moving you' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = v_uid AND m.state = 'pending') THEN
    RAISE EXCEPTION 'MOVE_PENDING: you are already being moved' USING ERRCODE = 'check_violation';
  END IF;

  -- Idempotent: the open request is the answer.
  SELECT * INTO q FROM public.cash_seat_change_requests
   WHERE game_id = g.id AND user_id = v_uid AND status = 'requested';
  IF FOUND THEN
    RETURN public.fn_cash_seat_change_status(g.id, v_uid);
  END IF;

  SELECT * INTO ro FROM public.cash_game_roster WHERE game_id = g.id AND user_id = v_uid AND left_at IS NULL;
  IF NOT FOUND THEN
    -- A chair that predates the roster: put them on it now, at the chair's time.
    INSERT INTO public.cash_game_roster (game_id, user_id, joined_at)
    SELECT g.id, v_uid, coalesce(min(ts.joined_at), now()) FROM public.table_seats ts
     WHERE ts.user_id = v_uid AND ts.table_id = me.table_id AND ts.left_at IS NULL
    RETURNING * INTO ro;
  END IF;
  IF ro.seat_change_used_at IS NOT NULL THEN
    RAISE EXCEPTION 'SEAT_CHANGE_USED: you have used your seat change for this game' USING ERRCODE = 'check_violation';
  END IF;

  IF p_to_table_id IS NOT NULL THEN
    SELECT * INTO dst FROM public.tables WHERE id = p_to_table_id;
    IF NOT FOUND OR dst.cluster_id IS DISTINCT FROM g.id OR coalesce(dst.is_deleted, false)
       OR dst.lifecycle NOT IN ('live', 'opening') THEN
      RAISE EXCEPTION 'SEAT_CHANGE_TABLE_UNAVAILABLE: that table is not open in this game' USING ERRCODE = 'check_violation';
    END IF;
    IF dst.role = 'main' AND dst.main_index = 1 THEN
      RAISE EXCEPTION 'SEAT_CHANGE_NEVER_TO_MAIN: the main game fills in must-move order only' USING ERRCODE = 'check_violation';
    END IF;
    IF dst.id = me.table_id THEN
      RAISE EXCEPTION 'SEAT_CHANGE_SAME_TABLE: you are already at that table' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.tables t
                    WHERE t.cluster_id = g.id AND t.id <> me.table_id AND coalesce(t.is_deleted, false) = false
                      AND t.lifecycle IN ('live', 'opening') AND NOT (t.role = 'main' AND t.main_index = 1)) THEN
      RAISE EXCEPTION 'SEAT_CHANGE_NO_OTHER_TABLE: there is no other table to change to yet' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  INSERT INTO public.cash_seat_change_requests (game_id, user_id, from_table_id, to_table_id)
  VALUES (g.id, v_uid, me.table_id, p_to_table_id);
  UPDATE public.cash_game_roster SET seat_change_used_at = now() WHERE id = ro.id;
  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
  VALUES (g.id, me.table_id, 'seat_change_requested',
          jsonb_build_object('player_id', v_uid, 'to_table_id', p_to_table_id));

  -- Try now: a chair open, or a partner waiting, and they are moving at
  -- their next hand boundary; otherwise they are on the list.
  PERFORM public.fn_cash_seat_change_plan(g.id, clock_timestamp());
  RETURN public.fn_cash_seat_change_status(g.id, v_uid);
END;
$$;

COMMENT ON FUNCTION public.fn_cash_seat_change_request(uuid, uuid, uuid) IS
  'The once-per-stay seat change on a must-move game. p_user_id is honoured ONLY when fn_caller_is_engine() - the engine asking on behalf of a horse (CLAUDE.md 10.5); a browser is always its own auth.uid().';

-- ---------------------------------------------------------------------------
-- 2. THE MOVE CARRIES THE SIT-OUT
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_execute(p_move_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  m record; src record; dst record; v_seat integer; v_new_id uuid; v_stack numeric;
  v_hold text; v_agreed boolean;
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
  -- A LINKED MOVE IS A SWAP (2026-09-05): both chairs are occupied and both
  -- land together.
  IF m.swap_move_id IS NOT NULL THEN
    RETURN public.fn_cash_seat_swap_execute(m.id);
  END IF;

  SELECT * INTO src FROM public.table_seats
   WHERE table_id = m.from_table_id AND user_id = m.player_id AND left_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'player_not_seated' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'player_not_seated');
  END IF;

  -- NOTHING IS MOVED WITH NOTHING (2026-09-05). A busted player is in their
  -- rebuy window, or about to be stood up; either way the chair they are in
  -- is the one that resolves it. Cancelled, not expired: the planner leaves
  -- them alone for a minute and looks again.
  IF coalesce(src.stack, 0) <= 0 THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'busted' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'busted');
  END IF;

  SELECT * INTO dst FROM public.tables WHERE id = m.to_table_id FOR UPDATE;
  IF NOT FOUND OR dst.status NOT IN ('waiting', 'running', 'active') OR dst.lifecycle IN ('breaking', 'closed') THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_unavailable' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_unavailable');
  END IF;

  -- The lowest open seat at the destination. (A notified waitlist hold is a
  -- COUNT the planner respected when it chose this table, not a seat number.)
  SELECT gs INTO v_seat FROM generate_series(1, coalesce(dst.max_players, 9)) gs
   WHERE NOT EXISTS (SELECT 1 FROM public.table_seats ts
                      WHERE ts.table_id = dst.id AND ts.seat_number = gs AND ts.left_at IS NULL)
   ORDER BY gs LIMIT 1;
  IF v_seat IS NULL THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_full' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_full');
  END IF;

  v_stack := src.stack;

  -- ENTRY BY REASON (Dan 2026-09-05). A seat change ARRIVES at a table: it
  -- posts the big blind (held until clear if it lands between the button and
  -- the blind). A must-move or a break is NOT an arrival - the player already
  -- posted at the table they came from - so they are dealt in on the next
  -- deal with nothing owed, and take the big blind when it comes round.
  v_hold := CASE WHEN m.reason = 'seat_change' THEN 'waiting' ELSE 'moved' END;
  v_agreed := (m.reason = 'seat_change');

  -- THIS IS A MOVE (2026-09-05). The four-table cap, the one-seat-per-game
  -- door and the roster all read this: for the rest of this transaction a
  -- seat write is a player changing chairs inside one game, not entering or
  -- leaving one.
  PERFORM set_config('app.cash_seat_move', 'on', true);

  -- New chair first, then the old, in ONE sub-transaction: the player is
  -- never, even inside this transaction, seatless. Stack to zero before
  -- leaving, so trg_log_seat_stack_exit sees no chips leave a chair whose
  -- chips went to another chair. If the new chair is refused, the exception
  -- block undoes everything and the plan is cancelled with the reason.
  --
  -- PRESENCE FOLLOWS THE PLAYER (2026-09-05). `is_sitting_out` and
  -- `sit_out_at` used to be written false/NULL here, so a player who was
  -- sitting out at the feeder was dealt into the first hand at the new table
  -- - the one hand they had chosen not to play - and then auto-folded through
  -- it. They are carried now, with the ORIGINAL `sit_out_at`: the sit-out's
  -- 5-minute eviction clock is the same clock it was before the move, not a
  -- fresh one, exactly as restoreSitOutsFromSeats insists for a restart.
  BEGIN
    UPDATE public.table_seats
       SET user_id = src.user_id, member_id = src.member_id, stack = v_stack,
           is_sitting_out = coalesce(src.is_sitting_out, false), sit_out_at = src.sit_out_at,
           is_away = coalesce(src.is_away, false),
           joined_at = src.joined_at,
           horse_id = src.horse_id, status = 'active', leave_pending = false,
           auto_rebuy = src.auto_rebuy, time_bank_remaining = src.time_bank_remaining,
           time_bank_uses_remaining = src.time_bank_uses_remaining, club_id = src.club_id,
           entry_hold = v_hold, entry_post_agreed = v_agreed, left_at = NULL
     WHERE table_id = dst.id AND seat_number = v_seat AND left_at IS NOT NULL
     RETURNING id INTO v_new_id;
    IF v_new_id IS NULL THEN
      INSERT INTO public.table_seats
        (table_id, seat_number, user_id, member_id, stack, is_sitting_out, is_away, sit_out_at, joined_at,
         horse_id, status, leave_pending, auto_rebuy, time_bank_remaining, time_bank_uses_remaining,
         club_id, entry_hold, entry_post_agreed)
      VALUES
        (dst.id, v_seat, src.user_id, src.member_id, v_stack,
         coalesce(src.is_sitting_out, false), coalesce(src.is_away, false), src.sit_out_at, src.joined_at,
         src.horse_id, 'active', false, src.auto_rebuy, src.time_bank_remaining, src.time_bank_uses_remaining,
         src.club_id, v_hold, v_agreed)
      RETURNING id INTO v_new_id;
    END IF;
    UPDATE public.table_seats SET stack = 0 WHERE id = src.id;
    UPDATE public.table_seats SET left_at = clock_timestamp(), leave_pending = false, status = 'left'
     WHERE id = src.id;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.cash_seat_move', '', true);
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = left(SQLERRM, 200) WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_refused', 'detail', left(SQLERRM, 200));
  END;
  PERFORM set_config('app.cash_seat_move', '', true);

  -- The chip-continuity session follows the player: baseline, clock and
  -- window untouched. This is the "cluster" scope Slice 0 promised.
  UPDATE public.cash_player_session
     SET scope_id = dst.id, table_id = dst.id
   WHERE player_id = m.player_id AND scope_type = 'table' AND scope_id = m.from_table_id AND closed_at IS NULL;

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

  RETURN jsonb_build_object('ok', true, 'to_table_id', m.to_table_id, 'to_seat_number', v_seat, 'stack', v_stack,
                            'reason', m.reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_cash_seat_swap_execute(p_move_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  m record; pm record; a record; b record; ta record; tb record;
  v_stack_a numeric; v_stack_b numeric; v_now timestamptz := clock_timestamp();
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'frozen');
  END IF;
  -- Lock both rows in id order, whichever side calls, so two engines
  -- arriving together cannot deadlock on each other's row.
  PERFORM 1 FROM public.cash_seat_moves
   WHERE id IN (p_move_id, (SELECT swap_move_id FROM public.cash_seat_moves WHERE id = p_move_id))
   ORDER BY id FOR UPDATE;
  SELECT * INTO m FROM public.cash_seat_moves WHERE id = p_move_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF m.state <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'reason', m.state); END IF;
  SELECT * INTO pm FROM public.cash_seat_moves WHERE id = m.swap_move_id;
  IF NOT FOUND OR pm.state <> 'pending' OR pm.expires_at <= v_now OR m.expires_at <= v_now THEN
    UPDATE public.cash_seat_moves SET state = CASE WHEN m.expires_at <= v_now THEN 'expired' ELSE 'cancelled' END,
           note = 'swap_partner_gone'
     WHERE id = m.id;
    IF pm.id IS NOT NULL AND pm.state = 'pending' THEN
      UPDATE public.cash_seat_moves SET state = 'expired', note = 'swap_partner_gone' WHERE id = pm.id;
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'swap_partner_gone');
  END IF;

  SELECT * INTO a FROM public.table_seats
   WHERE table_id = m.from_table_id AND user_id = m.player_id AND left_at IS NULL FOR UPDATE;
  SELECT * INTO b FROM public.table_seats
   WHERE table_id = pm.from_table_id AND user_id = pm.player_id AND left_at IS NULL FOR UPDATE;
  IF a.id IS NULL OR b.id IS NULL OR coalesce(a.stack, 0) <= 0 OR coalesce(b.stack, 0) <= 0 THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled',
           note = CASE WHEN a.id IS NULL THEN 'player_not_seated' WHEN coalesce(a.stack, 0) <= 0 THEN 'busted' ELSE 'swap_partner_gone' END
     WHERE id = m.id;
    UPDATE public.cash_seat_moves SET state = 'cancelled',
           note = CASE WHEN b.id IS NULL THEN 'player_not_seated' WHEN coalesce(b.stack, 0) <= 0 THEN 'busted' ELSE 'swap_partner_gone' END
     WHERE id = pm.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'swap_cancelled');
  END IF;
  SELECT * INTO ta FROM public.tables WHERE id = m.to_table_id;
  SELECT * INTO tb FROM public.tables WHERE id = pm.to_table_id;
  IF ta.lifecycle IN ('breaking', 'closed') OR tb.lifecycle IN ('breaking', 'closed') THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_unavailable' WHERE id IN (m.id, pm.id);
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_unavailable');
  END IF;

  -- This side has reached its hand boundary.
  IF m.ready_at IS NULL THEN
    UPDATE public.cash_seat_moves SET ready_at = v_now WHERE id = m.id;
  END IF;
  IF pm.ready_at IS NULL THEN
    -- Hold this player out of the next deal; the other table lands the swap.
    RETURN jsonb_build_object('ok', false, 'reason', 'waiting_partner', 'held', true,
                              'to_table_id', m.to_table_id, 'partner_id', pm.player_id);
  END IF;

  -- Both ready: the two chairs change hands in one sub-transaction.
  -- Each side carries its OWN sit-out across, for the reason written on
  -- fn_cash_seat_move_execute above: a swap is two moves, and neither player
  -- asked to be dealt into a hand they had sat out of.
  v_stack_a := a.stack; v_stack_b := b.stack;
  PERFORM set_config('app.cash_seat_move', 'on', true);
  BEGIN
    UPDATE public.table_seats SET stack = 0 WHERE id IN (a.id, b.id);
    UPDATE public.table_seats SET left_at = v_now, leave_pending = false, status = 'left' WHERE id IN (a.id, b.id);
    -- A takes B's chair (B's row, revived under A), B takes A's.
    UPDATE public.table_seats
       SET user_id = a.user_id, member_id = a.member_id, stack = v_stack_a,
           is_sitting_out = coalesce(a.is_sitting_out, false), sit_out_at = a.sit_out_at,
           is_away = coalesce(a.is_away, false),
           joined_at = a.joined_at, horse_id = a.horse_id, status = 'active', leave_pending = false,
           auto_rebuy = a.auto_rebuy, time_bank_remaining = a.time_bank_remaining,
           time_bank_uses_remaining = a.time_bank_uses_remaining, club_id = a.club_id,
           entry_hold = 'waiting', entry_post_agreed = true, left_at = NULL
     WHERE id = b.id;
    UPDATE public.table_seats
       SET user_id = b.user_id, member_id = b.member_id, stack = v_stack_b,
           is_sitting_out = coalesce(b.is_sitting_out, false), sit_out_at = b.sit_out_at,
           is_away = coalesce(b.is_away, false),
           joined_at = b.joined_at, horse_id = b.horse_id, status = 'active', leave_pending = false,
           auto_rebuy = b.auto_rebuy, time_bank_remaining = b.time_bank_remaining,
           time_bank_uses_remaining = b.time_bank_uses_remaining, club_id = b.club_id,
           entry_hold = 'waiting', entry_post_agreed = true, left_at = NULL
     WHERE id = a.id;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.cash_seat_move', '', true);
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = left(SQLERRM, 200) WHERE id IN (m.id, pm.id);
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_refused', 'detail', left(SQLERRM, 200));
  END;
  PERFORM set_config('app.cash_seat_move', '', true);

  UPDATE public.cash_player_session SET scope_id = m.to_table_id, table_id = m.to_table_id
   WHERE player_id = m.player_id AND scope_type = 'table' AND scope_id = m.from_table_id AND closed_at IS NULL;
  UPDATE public.cash_player_session SET scope_id = pm.to_table_id, table_id = pm.to_table_id
   WHERE player_id = pm.player_id AND scope_type = 'table' AND scope_id = pm.from_table_id AND closed_at IS NULL;

  UPDATE public.cash_seat_moves SET state = 'done', executed_at = v_now, to_seat_number = b.seat_number WHERE id = m.id;
  UPDATE public.cash_seat_moves SET state = 'done', executed_at = v_now, to_seat_number = a.seat_number WHERE id = pm.id;
  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
  VALUES (m.game_id, m.to_table_id, 'seat_moved',
          jsonb_build_object('player_id', m.player_id, 'from_table_id', m.from_table_id, 'to_seat', b.seat_number,
                             'stack', v_stack_a, 'reason', 'seat_change', 'swap', true)),
         (pm.game_id, pm.to_table_id, 'seat_moved',
          jsonb_build_object('player_id', pm.player_id, 'from_table_id', pm.from_table_id, 'to_seat', a.seat_number,
                             'stack', v_stack_b, 'reason', 'seat_change', 'swap', true));
  RETURN jsonb_build_object('ok', true, 'swap', true, 'to_table_id', m.to_table_id, 'to_seat_number', b.seat_number,
                            'stack', v_stack_a,
                            'partner', jsonb_build_object('player_id', pm.player_id, 'from_table_id', pm.from_table_id,
                                                          'to_table_id', pm.to_table_id, 'to_seat_number', a.seat_number,
                                                          'stack', v_stack_b));
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Grants - the new signature carries exactly the old one's
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.fn_cash_seat_change_request(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_change_request(uuid, uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Assertions - the migration aborts rather than half-landing
-- ---------------------------------------------------------------------------

DO $$
DECLARE v_n integer;
BEGIN
  -- Exactly ONE fn_cash_seat_change_request. Two would make the client's own
  -- two-argument call ambiguous and break every human seat change.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_cash_seat_change_request';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_cash_seat_change_request must exist exactly once, found %', v_n;
  END IF;

  /* THREE ARGUMENTS, and p_user_id gated on the engine predicate.
     `pronargs` rather than a string compare against
     pg_get_function_identity_arguments: on this server that function returns
     the parameter NAMES as well as the types ("p_game_id uuid, p_to_table_id
     uuid"), so a literal 'uuid, uuid, uuid' never matches and the assertion
     fires on a migration that is perfectly correct. Measured 2026-09-05, on
     the first apply of this file. */
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_cash_seat_change_request'
     AND p.pronargs = 3
     AND pg_get_function_arguments(p.oid) ~ 'p_user_id uuid DEFAULT NULL'
     AND pg_get_functiondef(p.oid) ~ 'fn_caller_is_engine';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the seat-change door must take three arguments and gate p_user_id on fn_caller_is_engine';
  END IF;

  -- Neither executor may reset a sit-out on arrival ever again.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('fn_cash_seat_move_execute', 'fn_cash_seat_swap_execute')
     AND pg_get_functiondef(p.oid) ~ 'is_sitting_out = false';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'a seat move still resets is_sitting_out at the destination (% function(s))', v_n;
  END IF;
END;
$$;

COMMIT;
