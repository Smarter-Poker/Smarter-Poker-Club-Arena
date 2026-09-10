-- 20260909181259_a_leave_cancels_the_move_and_a_move_says_why_it_expired
--
-- Version reserved by scripts/reserve-migration-version.sh (CLAUDE.md 4.5).
-- Lane B of the 2026-09-09 must-move audit
-- (docs/audits/2026-09-09-must-move-audit/lane-B.md). NOT applied by the lane;
-- probed ROLLED BACK against production and handed to the integrator.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  A LEAVE CANCELS THE MOVE, AND THREE SMALLER TRUTHS ROUND THE SEAT CHANGE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The filename still says "and a move says why it expired". IT NO LONGER DOES
-- THAT: lane A found the same two executor expiry paths and fixed them better,
-- in `20260909181642_every_expiry_says_why_including_the_executors.sql`
-- (it separates `own_ttl_expired` from `swap_partner_gone` and stops recording
-- a live partner as expired, which this lane's draft did not). That half is
-- DELETED from here rather than duplicated - two migrations rewriting one
-- statement is a coin flip decided by apply order. The name is kept because
-- the version is already reserved and a renamed file is a second reservation.
--
-- WHAT IS LEFT, all four measured on the LIVE bodies (pg_get_functiondef):
--
-- ── 1. A LEAVE CANCELS THE MOVE (P1) ───────────────────────────────────────
--
-- `fn_cash_game_roster_track` closed the roster row on an undeclared
-- chair-empty only when the player had NO pending move:
--
--     AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m
--                      WHERE m.player_id = NEW.user_id AND m.game_id = v_game
--                        AND m.state = 'pending')
--
-- The executor and the swap both declare themselves
-- (`app.cash_seat_move = 'on'`), so an UNDECLARED empty chair is a leave every
-- time and that third clause cannot tell "still in the game" from "left with a
-- move still planned". Three consequences:
--
--   (a) THE DESTINATION CHAIR STAYS RESERVED for a player who has gone, until
--       the from-table's next hand boundary refuses the move. Every count of
--       open chairs subtracts pending moves - `fn_cash_game_open_seats`,
--       `fn_cash_cluster_census`, the planner, the break step, the fleet - so
--       the whole game sees one fewer chair than exists, for the length of
--       `fn_cash_seat_move_window` (3 to 15 minutes). MEASURED: 137 moves
--       cancelled `player_not_seated` in 24 hours.
--   (b) A REJOIN INSIDE THAT WINDOW KEEPS THE OLD ROSTER ROW: the old
--       `joined_at`, so the old must-move position, and the old
--       `seat_change_used_at`, so no seat change. Dan: "IF THEY LEAVE A TABLE
--       AND JOIN THE SAME GAME AND STAKES AGAIN, THEY GO TO THE BOTTOM OF THE
--       LIST." MEASURED over three days: 63 rejoins into the same game within
--       20 minutes of such a cancellation, 2 of them spanned by the old row.
--       The other 61 landed after the tick's reconcile had closed it - the net
--       catching what the live path got wrong, which CLAUDE.md 10.12 says is
--       the proof the live path is wrong, not the fix.
--   (c) A SWAP PARTNER IS HELD OUT OF THE DEAL until its own expiry, waiting
--       for a side that will never come, because nothing cancels the leaver's.
--
-- Now: the same undeclared-leave branch cancels the player's pending move
-- (`player_left_game`), releases a linked swap partner (`swap_partner_gone`,
-- so the held player is dealt back in at the next boundary and the tick puts
-- their request back on the list), closes the roster row and cancels a listed
-- request, all in one trigger.
--
-- WHY THE TRIGGER CAN DO THIS AT ALL: it is SECURITY INVOKER, and neither
-- `authenticated` nor `anon` can reach `cash_seat_moves` after part 4 below.
-- Checked: `table_seats` RLS has no browser write policy ("Public read
-- access" and "union_overseer_read" are SELECT; "Service role manages" is
-- ALL), so every seat write already arrives from a SECURITY DEFINER RPC or
-- from service_role, and the trigger's writes run with those privileges. Its
-- pre-existing `UPDATE public.cash_seat_change_requests` - a table
-- `authenticated` has never held a grant on - is reachable for exactly the
-- same reason and has worked since 2026-09-05.
--
-- ── 2. A SEAT CHANGE OFF A TABLE THAT BECAME MAIN 1 (P2) ───────────────────
--
-- `fn_cash_seat_change_request` refuses a request FROM Main 1
-- (`SEAT_CHANGE_NOT_FROM_MAIN`) and TO Main 1 (`SEAT_CHANGE_NEVER_TO_MAIN`),
-- and the planner refuses a swap PARTNER sitting on Main 1. Nothing re-checks
-- the REQUESTER's own table after the request is listed - and the tick's ROLES
-- step renumbers tables every pass (`feeder_became_main1` when no main is
-- live, `main_renumbered` when a main closes). So a request listed from a
-- feeder was executed as a seat change off the main game once that feeder
-- became Main 1. Dan: "NEVER TO THE MAIN GAME", and the main game has no seat
-- change at all.
--
-- It is cancelled with note `now_on_main_one` AND THE ALLOWANCE IS RETURNED -
-- the same shape as `20260907164541_a_seat_change_nobody_got_comes_back`: a
-- change the system made for its own reasons is not the change they asked for
-- and must not spend the one they get.
--
-- ── 3. A REQUEST WHOSE MOVE DIED WHILE THE PLAYER WAS ELSEWHERE (P2) ───────
--
-- The tick re-lists a `moved` request when its move dies, but only when the
-- player is still in `rq.from_table_id`:
--
--     AND EXISTS (SELECT 1 FROM public.table_seats ts
--                  WHERE ts.table_id = rq.from_table_id AND ts.user_id = rq.user_id
--                    AND ts.left_at IS NULL)
--
-- If the move died AND a must-move or a break had already taken the player to
-- another table of the same game, the request stays `status = 'moved'` for
-- ever with the allowance spent and no move delivered. Same class as the
-- 09-07 defect, one level up. MEASURED 2026-09-09: 0 rows in that state right
-- now, and all 3 open roster rows with a spent allowance have a live request
-- or a delivered move behind them - latent, not a live loss, hence P2 and
-- hence the narrowest possible fix: the EXISTS is widened from the from-table
-- to the GAME, and the request is re-listed from the table they are actually
-- at, so the planner reads a `from_table_id` that is true.
--
-- ── 4. THE GRANTS SAY WHAT RLS ALREADY ENFORCES (P3) ───────────────────────
--
-- `authenticated` held INSERT, UPDATE and DELETE on `cash_seat_moves` and
-- `cash_game_waitlist` with exactly one RLS policy on each, both FOR SELECT.
-- So RLS refused every write and the grant was a lie about who may write -
-- the same defect class as `20260905073614_the_seat_move_executors_are_engine_only_and_say_so`,
-- and the reason `cash_seat_change_requests` and `cash_game_roster` are
-- already service_role-only. Revoked; SELECT (the read-own policies) stays.
--
-- HOW THIS EDITS THE FUNCTIONS, and why it composes with lane A.
--   - Parts 1 and 2 replace two whole bodies that NO other migration in this
--     audit touches (checked against 181208, 181220, 181230, 181309, 181632,
--     181642, 181653, 181704). They are guarded by the live md5 and skip
--     themselves if already applied.
--   - Part 3 patches `fn_cash_cluster_tick` by ONE anchored literal, read live
--     at apply time, exactly as lane A's three tick migrations do. Its anchor
--     is the seat-change re-list statement; lane A's are the expiry sweep
--     (181632), the worklist (181653, a different function) and the ROLES
--     demote (181704). All four anchors are disjoint, so the four migrations
--     apply in ANY order, and each refuses rather than guesses if its anchor
--     has moved.
--
-- ROLLBACK
--   Restore `fn_cash_game_roster_track` from
--     20260905060000_the_must_move_lobby_a_seat_change_and_the_order_you_joined.sql
--   Restore `fn_cash_seat_change_plan` from
--     20260907164541_a_seat_change_nobody_got_comes_back.sql
--   In `fn_cash_cluster_tick`, put the re-list statement's EXISTS back to
--     `ts.table_id = rq.from_table_id` and drop the `from_table_id =` set.
--   GRANT INSERT, UPDATE, DELETE ON public.cash_seat_moves,
--     public.cash_game_waitlist TO authenticated;
--
-- ONE transaction (production DDL policy, CLAUDE.md section 2).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── 1. A LEAVE CANCELS THE MOVE ─────────────────────────────────────────────
DO $migration$
BEGIN
  IF position('player_left_game' in
      (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_cash_game_roster_track()'::regprocedure)) > 0 THEN
    RAISE NOTICE 'roster track already applied';
    RETURN;
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_cash_game_roster_track()'::regprocedure)
     <> 'a441e273d59ee341da01956c6123280d' THEN
    RAISE EXCEPTION 'fn_cash_game_roster_track is not the body this migration reviewed; re-read it before applying';
  END IF;

  EXECUTE $body$
CREATE OR REPLACE FUNCTION public.fn_cash_game_roster_track()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_game uuid;
  v_move uuid;
BEGIN
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  SELECT cluster_id INTO v_game FROM public.tables WHERE id = NEW.table_id;
  IF v_game IS NULL THEN RETURN NEW; END IF;

  BEGIN
    IF NEW.left_at IS NULL THEN
      -- A live chair in the game. On the roster once, at the time of the
      -- first chair; a second chair (a move, mid-transaction) changes nothing.
      INSERT INTO public.cash_game_roster (game_id, user_id, joined_at)
      VALUES (v_game, NEW.user_id, coalesce(NEW.joined_at, now()))
      ON CONFLICT (game_id, user_id) WHERE left_at IS NULL DO NOTHING;
    ELSIF TG_OP = 'UPDATE' AND OLD.left_at IS NULL THEN
      -- The chair emptied. A move declares itself (app.cash_seat_move) and is
      -- not a leave; a player with another live chair in the game is still in
      -- the game. ANYTHING ELSE IS A LEAVE, whatever was planned for them.
      --
      -- A LEAVE CANCELS THE MOVE (2026-09-09). This used to wait while a move
      -- was pending, so the destination chair stayed reserved for a player who
      -- had gone, a swap partner was held for a side that would never come,
      -- and a rejoin inside that window kept the old roster row - the old list
      -- position and the old seat change. Dan: a player who leaves and joins
      -- the same game again goes to the BOTTOM of the list.
      IF current_setting('app.cash_seat_move', true) IS DISTINCT FROM 'on'
         AND NOT EXISTS (SELECT 1 FROM public.table_seats ts
                           JOIN public.tables t ON t.id = ts.table_id
                          WHERE ts.user_id = NEW.user_id AND ts.left_at IS NULL AND ts.id <> NEW.id
                            AND t.cluster_id = v_game AND t.lifecycle <> 'closed') THEN
        -- One pending move per player (cash_seat_moves_one_pending_per_player),
        -- so a scalar RETURNING is the whole set.
        v_move := NULL;
        UPDATE public.cash_seat_moves m
           SET state = 'cancelled', note = 'player_left_game'
         WHERE m.player_id = NEW.user_id AND m.game_id = v_game AND m.state = 'pending'
        RETURNING m.id INTO v_move;
        -- A swap partner is released at once: the held side is dealt back in
        -- at its next boundary and the tick puts its request back on the list.
        IF v_move IS NOT NULL THEN
          UPDATE public.cash_seat_moves p
             SET state = 'cancelled', note = 'swap_partner_gone'
           WHERE p.swap_move_id = v_move AND p.state = 'pending';
        END IF;
        UPDATE public.cash_game_roster SET left_at = now()
         WHERE game_id = v_game AND user_id = NEW.user_id AND left_at IS NULL;
        UPDATE public.cash_seat_change_requests
           SET status = 'cancelled', resolved_at = now(), note = 'left_game'
         WHERE game_id = v_game AND user_id = NEW.user_id AND status = 'requested';
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_cash_game_roster_track: % (seat %, user %)', SQLERRM, NEW.id, NEW.user_id;
  END;
  RETURN NEW;
END;
$function$
  $body$;
END;
$migration$;

-- ── 2. A REQUEST FROM A TABLE THAT BECAME MAIN 1 COMES BACK ─────────────────
DO $migration$
BEGIN
  IF position('now_on_main_one' in
      (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_cash_seat_change_plan(uuid, timestamptz)'::regprocedure)) > 0 THEN
    RAISE NOTICE 'seat change planner already applied';
    RETURN;
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_cash_seat_change_plan(uuid, timestamptz)'::regprocedure)
     <> '424e5c6ade9b6c8adf3f97a211b9b838' THEN
    RAISE EXCEPTION 'fn_cash_seat_change_plan is not the body this migration reviewed; re-read it before applying';
  END IF;

  EXECUTE $body$
CREATE OR REPLACE FUNCTION public.fn_cash_seat_change_plan(p_game_id uuid, p_now timestamp with time zone DEFAULT clock_timestamp())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; p record;
  v_census public.cash_cluster_census_row[];
  v_target uuid;
  v_moves integer := 0;
  v_move_a uuid; v_move_b uuid;
  v_seat_a integer; v_seat_b integer;
BEGIN
  v_census := public.fn_cash_cluster_census(p_game_id, p_now);

  FOR r IN SELECT q.* FROM public.cash_seat_change_requests q
            WHERE q.game_id = p_game_id AND q.status = 'requested'
            ORDER BY q.created_at, q.id
  LOOP
    -- Still in that chair, with chips, not on the way out?
    IF NOT EXISTS (SELECT 1 FROM public.table_seats ts
                    WHERE ts.table_id = r.from_table_id AND ts.user_id = r.user_id AND ts.left_at IS NULL) THEN
      UPDATE public.cash_seat_change_requests
         SET status = 'cancelled', resolved_at = p_now, note = 'left_table'
       WHERE id = r.id;
      -- AND THE BUTTON COMES BACK. This request is being cancelled for a
      -- reason that is not the player's doing and did not move them where they
      -- asked, so it must not spend the one change they get for this game.
      -- fn_cash_seat_change_cancel has done exactly this for the player's own
      -- cancel since day one; this is the same event arriving from the planner.
      UPDATE public.cash_game_roster
         SET seat_change_used_at = NULL
       WHERE game_id = p_game_id AND user_id = r.user_id AND left_at IS NULL;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (p_game_id, r.from_table_id, 'seat_change_returned',
              jsonb_build_object('player_id', r.user_id, 'reason', 'left_table'));
      CONTINUE;
    END IF;
    -- THE MAIN GAME HAS NO SEAT CHANGE (2026-09-09). The door refuses a
    -- request FROM Main 1 and the swap below refuses a partner on Main 1, but
    -- a request already listed from a feeder that the ROLES step then
    -- renumbered to Main 1 (the old Main 1 closed) was still executed off the
    -- main game. Same event as left_table: the table they asked from is not
    -- the table they asked from any more, the change is one the game made and
    -- not the one they asked for, so the button comes back.
    IF EXISTS (SELECT 1 FROM unnest(v_census) c
                WHERE c.id = r.from_table_id AND c.role = 'main' AND c.main_index = 1) THEN
      UPDATE public.cash_seat_change_requests
         SET status = 'cancelled', resolved_at = p_now, note = 'now_on_main_one'
       WHERE id = r.id;
      UPDATE public.cash_game_roster
         SET seat_change_used_at = NULL
       WHERE game_id = p_game_id AND user_id = r.user_id AND left_at IS NULL;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (p_game_id, r.from_table_id, 'seat_change_returned',
              jsonb_build_object('player_id', r.user_id, 'reason', 'now_on_main_one'));
      CONTINUE;
    END IF;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.table_seats ts
                               WHERE ts.table_id = r.from_table_id AND ts.user_id = r.user_id AND ts.left_at IS NULL
                                 AND coalesce(ts.stack, 0) > 0 AND coalesce(ts.leave_pending, false) = false);
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = r.user_id AND m.state = 'pending');
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.cash_seat_moves m
                           WHERE m.player_id = r.user_id AND m.state = 'cancelled' AND m.created_at > p_now - interval '60 seconds');

    -- A chair: the table they asked for, or (any) the shortest other table
    -- that is not Main 1 and not closing.
    SELECT c.id INTO v_target FROM unnest(v_census) c
     WHERE c.id <> r.from_table_id AND NOT c.breaking AND c.lifecycle IN ('live', 'opening')
       AND NOT (c.role = 'main' AND c.main_index = 1)
       AND (r.to_table_id IS NULL OR c.id = r.to_table_id)
       AND c.open_unreserved
           - (SELECT count(*) FROM public.cash_seat_moves m
               WHERE m.to_table_id = c.id AND m.state = 'pending' AND m.swap_move_id IS NULL) > 0
     ORDER BY c.seated ASC, c.created_at ASC LIMIT 1;
    IF v_target IS NOT NULL THEN
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason)
      VALUES (p_game_id, r.user_id, r.from_table_id, v_target, 'seat_change')
      RETURNING id INTO v_move_a;
      UPDATE public.cash_seat_change_requests
         SET status = 'moved', resolved_at = p_now, move_id = v_move_a, note = 'seat_open'
       WHERE id = r.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (p_game_id, v_target, 'move_planned',
              jsonb_build_object('player_id', r.user_id, 'from_table_id', r.from_table_id, 'reason', 'seat_change'));
      v_moves := v_moves + 1;
      CONTINUE;
    END IF;

    -- A swap: the oldest other request whose table I would take and who
    -- would take mine. Both chairs are occupied, so both moves are linked
    -- and land together (fn_cash_seat_swap_execute).
    SELECT q.*, ts.seat_number AS their_seat INTO p
      FROM public.cash_seat_change_requests q
      JOIN unnest(v_census) c ON c.id = q.from_table_id
      JOIN public.table_seats ts ON ts.table_id = q.from_table_id AND ts.user_id = q.user_id AND ts.left_at IS NULL
     WHERE q.game_id = p_game_id AND q.status = 'requested' AND q.id <> r.id
       AND q.from_table_id <> r.from_table_id
       AND (r.to_table_id IS NULL OR q.from_table_id = r.to_table_id)
       AND (q.to_table_id IS NULL OR q.to_table_id = r.from_table_id)
       AND NOT c.breaking AND c.lifecycle = 'live'
       AND NOT (c.role = 'main' AND c.main_index = 1)
       AND coalesce(ts.stack, 0) > 0 AND coalesce(ts.leave_pending, false) = false
       AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = q.user_id AND m.state = 'pending')
       AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m
                        WHERE m.player_id = q.user_id AND m.state = 'cancelled' AND m.created_at > p_now - interval '60 seconds')
     ORDER BY q.created_at, q.id LIMIT 1;
    IF FOUND THEN
      SELECT ts.seat_number INTO v_seat_a FROM public.table_seats ts
       WHERE ts.table_id = r.from_table_id AND ts.user_id = r.user_id AND ts.left_at IS NULL;
      v_seat_b := p.their_seat;
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason, to_seat_number)
      VALUES (p_game_id, r.user_id, r.from_table_id, p.from_table_id, 'seat_change', v_seat_b)
      RETURNING id INTO v_move_a;
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason, to_seat_number, swap_move_id)
      VALUES (p_game_id, p.user_id, p.from_table_id, r.from_table_id, 'seat_change', v_seat_a, v_move_a)
      RETURNING id INTO v_move_b;
      UPDATE public.cash_seat_moves SET swap_move_id = v_move_b WHERE id = v_move_a;
      UPDATE public.cash_seat_change_requests
         SET status = 'moved', resolved_at = p_now, move_id = v_move_a, note = 'swap'
       WHERE id = r.id;
      UPDATE public.cash_seat_change_requests
         SET status = 'moved', resolved_at = p_now, move_id = v_move_b, note = 'swap'
       WHERE id = p.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (p_game_id, p.from_table_id, 'swap_planned',
              jsonb_build_object('player_id', r.user_id, 'with_player_id', p.user_id,
                                 'from_table_id', r.from_table_id, 'to_table_id', p.from_table_id));
      v_moves := v_moves + 2;
    END IF;
  END LOOP;
  RETURN v_moves;
END;
$function$
  $body$;
END;
$migration$;

-- ── 3. A REQUEST WHOSE MOVE DIED WHILE THE PLAYER WAS ELSEWHERE ────────────
DO $migration$
DECLARE
  v_src text;
  v_new text;
  v_anchor CONSTANT text := $old$  UPDATE public.cash_seat_change_requests rq SET status = 'requested', resolved_at = NULL, move_id = NULL, note = 'move_' || mv.state
    FROM public.cash_seat_moves mv
   WHERE rq.game_id = g.id AND rq.status = 'moved' AND rq.move_id = mv.id AND mv.state IN ('cancelled', 'expired')
     AND EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = rq.from_table_id AND ts.user_id = rq.user_id AND ts.left_at IS NULL);$old$;
  v_repl CONSTANT text := $new$  -- THE REQUEST COMES BACK WHEREVER THEY ARE SITTING (2026-09-09). This
  -- asked whether the player was still in the table they REQUESTED FROM, so a
  -- request whose move died after a must-move or a break had already taken
  -- them elsewhere in the same game stayed 'moved' for ever, with the
  -- allowance spent and no change delivered. The player is asked for by GAME
  -- now, and the request is re-listed from the chair they are actually in, so
  -- the planner reads a from_table_id that is true.
  -- (a scalar subquery, not a LATERAL: Postgres refuses a lateral reference to
  --  the UPDATE target from the FROM list, 42P10. The EXISTS keeps the NOT NULL
  --  column honest - a player with no chair at all in the game is the roster
  --  trigger's case, not this one.)
  UPDATE public.cash_seat_change_requests rq
     SET status = 'requested', resolved_at = NULL, move_id = NULL, note = 'move_' || mv.state,
         from_table_id = (SELECT ts.table_id FROM public.table_seats ts
                            JOIN public.tables tb ON tb.id = ts.table_id
                           WHERE ts.user_id = rq.user_id AND ts.left_at IS NULL
                             AND tb.cluster_id = g.id AND tb.lifecycle <> 'closed'
                           ORDER BY ts.joined_at LIMIT 1)
    FROM public.cash_seat_moves mv
   WHERE rq.game_id = g.id AND rq.status = 'moved' AND rq.move_id = mv.id AND mv.state IN ('cancelled', 'expired')
     AND EXISTS (SELECT 1 FROM public.table_seats ts
                   JOIN public.tables tb ON tb.id = ts.table_id
                  WHERE ts.user_id = rq.user_id AND ts.left_at IS NULL
                    AND tb.cluster_id = g.id AND tb.lifecycle <> 'closed');$new$;
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);
  IF position('THE REQUEST COMES BACK WHEREVER THEY ARE SITTING' in v_src) > 0 THEN
    RAISE NOTICE 'tick re-list already applied';
  ELSE
    IF position(v_anchor in v_src) = 0 THEN
      RAISE EXCEPTION 'the seat-change re-list statement is not in the live definition in the shape this migration expects';
    END IF;
    v_new := replace(v_src, v_anchor, v_repl);
    -- Landmarks from every step of the tick, so a bad edit cannot pass.
    IF position('THE REQUEST COMES BACK WHEREVER THEY ARE SITTING' in v_new) = 0
       OR position('seat_changes_planned' in v_new) = 0
       OR position('feeder_abandoned' in v_new) = 0
       OR position('main1_reopened' in v_new) = 0
       OR position('table_break_started' in v_new) = 0
       OR position('game_woken' in v_new) = 0 THEN
      RAISE EXCEPTION 'a landmark of the cluster tick went missing in the edit';
    END IF;
    EXECUTE v_new;
  END IF;
END;
$migration$;

-- ── 4. THE GRANTS SAY WHAT RLS ENFORCES ─────────────────────────────────────
-- authenticated keeps SELECT (the read-own policies); the executors, the
-- planner and the trigger are the only writers, and every one of them runs as
-- the definer or as service_role.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.cash_seat_moves FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.cash_game_waitlist FROM authenticated, anon;

-- A definer states who may call it (2026-09-05).
REVOKE ALL ON FUNCTION public.fn_cash_seat_change_plan(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_change_plan(uuid, timestamptz) TO service_role;

-- ── POST-APPLY ASSERTIONS ───────────────────────────────────────────────────
DO $assert$
DECLARE v_roster text; v_plan text; v_tick text;
BEGIN
  v_roster := (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_cash_game_roster_track()'::regprocedure);
  v_plan   := (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_cash_seat_change_plan(uuid, timestamptz)'::regprocedure);
  v_tick   := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);

  IF position('player_left_game' in v_roster) = 0 OR position('swap_partner_gone' in v_roster) = 0 THEN
    RAISE EXCEPTION 'the roster trigger does not cancel the move of a player who left';
  END IF;
  -- The old clause must be GONE: a pending move may no longer keep a departed
  -- player on the roster.
  IF position($q$AND m.state = 'pending') THEN$q$ in v_roster) > 0 THEN
    RAISE EXCEPTION 'the roster trigger still waits on a pending move';
  END IF;
  IF position('now_on_main_one' in v_plan) = 0 THEN
    RAISE EXCEPTION 'the planner does not return the button to a player renumbered onto Main 1';
  END IF;
  -- The 09-07 fix must survive this replacement.
  IF position('left_table' in v_plan) = 0 OR position('seat_change_returned' in v_plan) = 0 THEN
    RAISE EXCEPTION 'the 2026-09-07 left_table return was lost';
  END IF;
  IF position('THE REQUEST COMES BACK WHEREVER THEY ARE SITTING' in v_tick) = 0 THEN
    RAISE EXCEPTION 'the tick still re-lists only from the requested table';
  END IF;
  IF has_table_privilege('authenticated', 'public.cash_seat_moves', 'INSERT')
     OR has_table_privilege('authenticated', 'public.cash_seat_moves', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.cash_game_waitlist', 'INSERT') THEN
    RAISE EXCEPTION 'a browser role can still write a seat move or a waitlist row';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.cash_seat_moves', 'SELECT') THEN
    RAISE EXCEPTION 'the read-own grant was revoked with the writes';
  END IF;
END;
$assert$;

COMMIT;
