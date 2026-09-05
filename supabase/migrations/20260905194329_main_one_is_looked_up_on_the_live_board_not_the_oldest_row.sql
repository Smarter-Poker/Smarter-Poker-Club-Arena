-- 20260905194329_main_one_is_looked_up_on_the_live_board_not_the_oldest_row.sql
--
-- MAIN 1 IS LOOKED UP ON THE LIVE BOARD, NOT THE OLDEST ROW (2026-09-05 14:45 CDT)
--
-- READ, NOT ASSUMED. cash_cluster_events for NLH 0.05/0.10 Classic
-- (37ac7634-...), 2026-09-05: main_opened 3,000 (08:01 to 10:29),
-- main_renumbered 3,114, move_planned 10,989, seat_moved 10,951. The game
-- holds 3,002 table rows; 16 are live for 43 players.
--
-- WHY. The R3 repair ("an enabled game always has Main 1 open") selected the
-- OLDEST table ever numbered Main 1 - `ORDER BY created_at LIMIT 1` with no
-- lifecycle filter. That game's original Main 1 was closed for good
-- (20260905083756's lifecycle_followed_status made its lifecycle agree with
-- its status), the game was re-enabled at 08:01, and from then on every tick
-- found that closed row, took the "open a new one" branch and opened another
-- Main 1. The roles step then renumbered, the break step broke, the moves
-- shuffled 43 players through 3,000 tables. The loop ended at 10:29 for a
-- reason that is not yet read; it can restart on any game whose original
-- Main 1 closes. Before 083756 the same row read lifecycle='live' and took
-- the harmless status-repair branch, which is why this never fired before.
-- The defect is in R3 and it is repaired here, at its root.
--
-- WHAT CHANGES. R3 looks for a Main 1 that is live or opening. One that is
-- live but whose status was set to closed is repaired as before. A game with
-- ANY live/opening/breaking table and no such Main 1 opens nothing: the roles
-- step (1.3 s9.2, oldest live table is Main 1) promotes and renumbers. Only a
-- game with no live table at all opens Main 1. And an enabled game's Main 1
-- is exempt from lifecycle_followed_status, so a status-only close on an
-- empty Main 1 is repaired in place (same id) rather than replaced.
--
-- CLEANUP. The 2,986 closed rows are left where they are: closed, no seats,
-- nothing reads them except history. The 16 live tables consolidate under
-- the break rule (everyone fits in five). Nothing is deleted.
--
-- Guard: live body must be 7bd855d7d10b6517c013b63aef5b3b1c; post: bf55d7a456afba498070a3d6e62c2002. One transaction.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_cash_cluster_tick';
  IF v_md5 IS DISTINCT FROM '7bd855d7d10b6517c013b63aef5b3b1c' THEN
    RAISE EXCEPTION 'fn_cash_cluster_tick live body is % (expected 7bd855d7d10b6517c013b63aef5b3b1c) - rebase this migration on the live source', coalesce(v_md5, 'absent');
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick(p_game_id uuid, p_eligible_horses integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g record; t record; r record;
  v_census public.cash_cluster_census_row[];
  v_actions jsonb := '[]'::jsonb;
  v_now timestamptz := clock_timestamp();
  v_seated_total integer := 0;
  v_live_tables integer := 0;
  v_open_unreserved integer := 0;
  v_buyers integer;
  v_waiting integer;
  v_prev_feeder record;
  v_candidate record;
  v_floor integer;
  v_remaining_capacity integer;
  v_remaining_tables integer;
  v_main1 record;
  v_new_state text;
  v_moves integer := 0;
  v_n integer;
  v_idx integer;
  v_shortest uuid;
  v_table_cap integer;
  v_res jsonb;
  v_hands integer;
  v_orbit integer;
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'skipped', 'frozen');
  END IF;

  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT g.must_move THEN RETURN jsonb_build_object('ok', false, 'reason', 'manual_game'); END IF;

  -- ── 1. RECONCILE ─────────────────────────────────────────────────────────
  UPDATE public.cash_seat_moves SET state = 'expired'
   WHERE game_id = g.id AND state = 'pending' AND expires_at <= v_now;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('moves_expired', v_n); END IF;

  -- THE SNAPSHOT IS THE RULE (Gate 5, 2026-09-05). Every open table of the
  -- game carries exactly the rules its snapshot says; a table that drifted
  -- (54 did, on the VPIP floor alone) is corrected here, every tick.
  v_n := public.fn_cash_apply_ruleset(g.id);
  IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('ruleset_applied', v_n); END IF;

  -- THE ROSTER AND THE SEAT-CHANGE LIST (Dan 2026-09-05). A roster row whose
  -- player holds no chair in the game and has no move planned is closed (the
  -- seat trigger closes most of them; this catches a chair that emptied
  -- while a move was pending and the move then died). A seat change whose
  -- move was cancelled or expired goes back on the list, at its old place;
  -- the back-off in the planner gives the refusal its minute.
  UPDATE public.cash_game_roster ro SET left_at = v_now
   WHERE ro.game_id = g.id AND ro.left_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
                      WHERE ts.user_id = ro.user_id AND ts.left_at IS NULL AND tb.cluster_id = g.id AND tb.lifecycle <> 'closed')
     AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves mv WHERE mv.player_id = ro.user_id AND mv.game_id = g.id AND mv.state = 'pending');
  UPDATE public.cash_seat_change_requests rq SET status = 'cancelled', resolved_at = v_now, note = 'left_game'
   WHERE rq.game_id = g.id AND rq.status = 'requested'
     AND NOT EXISTS (SELECT 1 FROM public.cash_game_roster ro WHERE ro.game_id = g.id AND ro.user_id = rq.user_id AND ro.left_at IS NULL);
  UPDATE public.cash_seat_change_requests rq SET status = 'requested', resolved_at = NULL, move_id = NULL, note = 'move_' || mv.state
    FROM public.cash_seat_moves mv
   WHERE rq.game_id = g.id AND rq.status = 'moved' AND rq.move_id = mv.id AND mv.state IN ('cancelled', 'expired')
     AND EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = rq.from_table_id AND ts.user_id = rq.user_id AND ts.left_at IS NULL);

  -- THE GAME WAITLIST (Gate 4, 2026-09-05). A row whose player now holds a
  -- seat in the game is `seated`; a `notified` row (the join door told them
  -- a seat was open) that has not turned into a seat in three minutes is
  -- `expired` - their browser asks again if they are still there, and the
  -- OPEN rule stops counting a buyer who left.
  UPDATE public.cash_game_waitlist w SET status = 'seated', updated_at = v_now
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified')
     AND EXISTS (SELECT 1 FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
                  WHERE ts.user_id = w.user_id AND ts.left_at IS NULL AND tb.cluster_id = g.id AND tb.lifecycle <> 'closed');
  UPDATE public.cash_game_waitlist w SET status = 'expired', updated_at = v_now
   WHERE w.game_id = g.id AND w.status = 'notified' AND w.updated_at < v_now - interval '3 minutes';

  -- A CLOSED TABLE WITH SOMEONE ON IT (2026-09-05). The census excludes
  -- closed tables, so a player who reached one (the seat guard below now
  -- refuses; this covers what got through before it, and any future hole)
  -- would never be planned out. It goes back to `breaking`, which the
  -- census sees and step 5 walks empty, then closes again.
  FOR t IN SELECT tb.id FROM public.tables tb
            WHERE tb.cluster_id = g.id AND tb.lifecycle = 'closed'
              AND coalesce(tb.is_deleted, false) = false
              AND EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL)
  LOOP
    UPDATE public.tables SET lifecycle = 'breaking', status = 'running', break_started_at = v_now, updated_at = now()
     WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'closed_table_reopened_to_break');
    v_actions := v_actions || jsonb_build_object('reopened_to_break', t.id);
  END LOOP;

  -- ONE CHAIR PER PLAYER PER GAME, EVERY TICK (2026-09-05). The door
  -- refuses a second chair now; before it did, the fleet seated the same
  -- horse at two tables of one game, and the tick only settled that on a
  -- BREAKING table (below). Found live: one horse on Main 1 since 17:01 and
  -- on the feeder since 19:17 the day before, both chairs idle. The roster
  -- is per player, so every such pair also read as one row of drift. The
  -- oldest chair is the player's; each newer one goes home through the
  -- same door as a Leave: between hands (table waiting) it is cashed out
  -- now, exactly as the breaking branch does; mid-game it is flagged
  -- leave_pending and the engine cashes it out at the hand boundary.
  FOR r IN
    SELECT ts.user_id, ts.table_id, ts.seat_number, ts.stack, tb.status,
           coalesce(ts.club_id, public.fn_player_home_club(ts.user_id, NULL)) AS club_id
      FROM public.table_seats ts
      JOIN public.tables tb ON tb.id = ts.table_id
     WHERE tb.cluster_id = g.id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
       AND tb.lifecycle <> 'closed' AND coalesce(tb.is_deleted, false) = false
       AND coalesce(ts.leave_pending, false) = false
       AND EXISTS (SELECT 1 FROM public.table_seats o JOIN public.tables ot ON ot.id = o.table_id
                    WHERE o.user_id = ts.user_id AND o.left_at IS NULL AND o.table_id <> ts.table_id
                      AND ot.cluster_id = g.id AND ot.lifecycle <> 'closed'
                      AND (o.joined_at < ts.joined_at OR (o.joined_at = ts.joined_at AND o.id < ts.id)))
  LOOP
    IF r.status = 'waiting' AND coalesce(r.stack, 0) > 0 AND r.club_id IS NOT NULL THEN
      PERFORM public.fn_ensure_club_wallet(r.user_id, r.club_id);
      PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', r.table_id);
      v_res := public.atomic_seat_cashout_locked(r.user_id, r.table_id, r.seat_number, 'forced');
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, r.table_id, 'second_chair_cashed_out',
              jsonb_build_object('player_id', r.user_id, 'seat', r.seat_number, 'stack', r.stack, 'club_id', r.club_id,
                                 'credited', v_res->'credited', 'key', v_res->'idempotency_key', 'where', 'reconcile'));
      v_actions := v_actions || jsonb_build_object('second_chair_cashed_out', r.user_id);
    ELSE
      UPDATE public.table_seats SET leave_pending = true
       WHERE table_id = r.table_id AND user_id = r.user_id AND left_at IS NULL;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, r.table_id, 'second_chair_leave_pending',
              jsonb_build_object('player_id', r.user_id, 'seat', r.seat_number, 'stack', r.stack, 'table_status', r.status));
      v_actions := v_actions || jsonb_build_object('second_chair_leave_pending', r.user_id);
    END IF;
  END LOOP;

  -- AN OPENING FEEDER NOBODY CAME TO (2026-09-05). It was opened for two
  -- buyers; three minutes with nobody on it means they went elsewhere. It
  -- closes, the live feeder it was going to promote stays the feeder, and
  -- OPEN below waits two minutes before trying again.
  FOR t IN SELECT tb.id FROM public.tables tb
            WHERE tb.cluster_id = g.id AND tb.lifecycle = 'opening'
              AND coalesce(tb.is_deleted, false) = false
              AND coalesce(tb.opened_at, tb.created_at) < v_now - interval '3 minutes'
              AND NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL)
  LOOP
    UPDATE public.tables SET status = 'closed', lifecycle = 'closed', current_players = 0, updated_at = now()
     WHERE id = t.id;
    UPDATE public.tables SET promote_pending = false
     WHERE cluster_id = g.id AND role = 'feeder' AND promote_pending;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'feeder_abandoned');
    v_actions := v_actions || jsonb_build_object('feeder_abandoned', t.id);
  END LOOP;

  -- A TABLE CLOSED BY STATUS BUT NOT BY LIFECYCLE (2026-09-05). Fifteen
  -- cluster tables carried status = 'closed' with lifecycle still 'live'
  -- (an operator's close-game action and the pre-controller close path
  -- write status only). The census reads status and drops them, the roles
  -- step reads lifecycle and still counts them, so a game could hold a
  -- Main 1 nobody could see and a feeder with nobody to feed. With no seat
  -- on it, the lifecycle follows the status; with a seat on it, the closed
  -- table sweep above has already put it back to breaking.
  UPDATE public.tables SET lifecycle = 'closed', current_players = 0, updated_at = now()
   WHERE cluster_id = g.id AND status = 'closed' AND lifecycle <> 'closed'
     AND coalesce(is_deleted, false) = false
     -- An enabled game's Main 1 is not followed down: R3 below repairs it in
     -- place (same id, same lobby links) instead of opening a replacement.
     AND NOT (g.enabled AND role = 'main' AND main_index = 1)
     AND NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = public.tables.id AND ts.left_at IS NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload) VALUES (g.id, 'lifecycle_followed_status', jsonb_build_object('tables', v_n));
    v_actions := v_actions || jsonb_build_object('lifecycle_followed_status', v_n);
  END IF;

  v_census := public.fn_cash_cluster_census(g.id, v_now);
  SELECT coalesce(sum(c.seated), 0), count(*) INTO v_seated_total, v_live_tables FROM unnest(v_census) c;

  -- R3: an enabled game always has Main 1 open. Anything that closed it
  -- (a stray close, the pre-controller lifecycle pass, a restart) is undone
  -- here rather than by a row flag.
  --
  -- THE LOOKUP READS THE LIVE BOARD, NOT THE OLDEST ROW (2026-09-05, 14:45).
  -- This used to select the oldest table ever numbered Main 1, closed or not.
  -- On NLH 0.05/0.10 Classic the original Main 1 was closed for good, so
  -- every tick found a closed row, took the "open a new one" branch, and
  -- opened a fresh Main 1: 3,000 tables in 148 minutes (08:01 to 10:29),
  -- every one of them then broken and renumbered by the steps below, 10,989
  -- moves planned to shuffle 43 players through them. Now: a Main 1 that is
  -- live or opening on a waiting/running table is the game's; a game with
  -- ANY live table but no such Main 1 leaves it to the ROLES step, which
  -- promotes the oldest live table (that is what Main 1 means, 1.3 s9.2);
  -- only a game with no live table at all opens one. The status-only repair
  -- (a live-lifecycle Main 1 whose status got set to closed) stays.
  SELECT * INTO v_main1 FROM public.tables
   WHERE cluster_id = g.id AND role = 'main' AND main_index = 1 AND coalesce(is_deleted, false) = false
     AND lifecycle IN ('live', 'opening')
   ORDER BY created_at LIMIT 1;
  IF g.enabled AND v_main1.id IS NOT NULL AND v_main1.status NOT IN ('waiting', 'running', 'active') THEN
    UPDATE public.tables SET status = 'waiting', lifecycle = 'live', current_players = 0, updated_at = now()
     WHERE id = v_main1.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, v_main1.id, 'main1_reopened');
    v_actions := v_actions || jsonb_build_object('main1', 'reopened');
    v_census := public.fn_cash_cluster_census(g.id, v_now);
    SELECT coalesce(sum(c.seated), 0), count(*) INTO v_seated_total, v_live_tables FROM unnest(v_census) c;
  ELSIF g.enabled AND v_main1.id IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.tables
                         WHERE cluster_id = g.id AND coalesce(is_deleted, false) = false
                           AND lifecycle IN ('live', 'opening', 'breaking') AND status IN ('waiting', 'running', 'active')) THEN
    PERFORM public.fn_cash_cluster_open_table(g.id, 'main', 1, 'live', NULL);
    v_actions := v_actions || jsonb_build_object('main1', 'opened');
    -- Recount after the repair; the rest of the tick sees the real board.
    v_census := public.fn_cash_cluster_census(g.id, v_now);
    SELECT coalesce(sum(c.seated), 0), count(*) INTO v_seated_total, v_live_tables FROM unnest(v_census) c;
  END IF;

  -- ── 2. MUST-MOVE (1.3 s9.5) ──────────────────────────────────────────────
  -- For every Main with an unreserved open seat, the longest-seated player on
  -- the feeder (or on a breaking table) is planned onto it, one per seat,
  -- one per player. The engine executes at the player's next hand boundary.
  FOR t IN SELECT * FROM unnest(v_census) c
            WHERE c.role = 'main' AND c.lifecycle = 'live' AND c.open_unreserved > 0
            ORDER BY c.main_index
  LOOP
    v_n := t.open_unreserved
         - (SELECT count(*) FROM public.cash_seat_moves m WHERE m.to_table_id = t.id AND m.state = 'pending' AND m.swap_move_id IS NULL);
    FOR r IN
      SELECT ts.user_id, ts.table_id
        FROM public.table_seats ts
        JOIN unnest(v_census) c ON c.id = ts.table_id
       WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
         -- A Main 1 seat draws from the WHOLE list (every table but Main 1);
         -- a Main N seat draws from the feeder and any breaking table.
         AND (c.role = 'feeder' OR c.breaking OR (t.main_index = 1 AND c.id <> t.id))
         AND c.id <> t.id
         -- NOT WITH NOTHING, NOT WHILE LEAVING (2026-09-05): a busted seat is
         -- in its rebuy window, a leave_pending seat is on its way out.
         AND coalesce(ts.stack, 0) > 0
         AND coalesce(ts.leave_pending, false) = false
         -- Never onto a table they are already sitting at.
         AND NOT EXISTS (SELECT 1 FROM public.table_seats d WHERE d.table_id = t.id AND d.user_id = ts.user_id AND d.left_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'pending')
         -- BACK-OFF (2026-09-05): a move the engine just refused (cancelled
         -- with a note) is not re-planned every 5 s; the refusal gets a minute.
         AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'cancelled' AND m.created_at > v_now - interval '60 seconds')
       -- THE ORDER YOU JOINED THE GAME (Dan 2026-09-05): the roster's
       -- joined_at, which survives every move; the chair's own joined_at
       -- only for a chair that predates the roster.
       ORDER BY c.breaking DESC,
                coalesce((SELECT r2.joined_at FROM public.cash_game_roster r2
                           WHERE r2.game_id = g.id AND r2.user_id = ts.user_id AND r2.left_at IS NULL), ts.joined_at) ASC,
                ts.joined_at ASC
       LIMIT GREATEST(v_n, 0)
    LOOP
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason)
      VALUES (g.id, r.user_id, r.table_id, t.id, 'must_move');
      v_moves := v_moves + 1;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, t.id, 'move_planned', jsonb_build_object('player_id', r.user_id, 'from_table_id', r.table_id, 'reason', 'must_move'));
    END LOOP;
  END LOOP;
  IF v_moves > 0 THEN v_actions := v_actions || jsonb_build_object('moves_planned', v_moves); END IF;

  -- ── 2b. SEAT CHANGES (Dan 2026-09-05) ────────────────────────────────────
  -- After Main seats are filled in must-move order and before a feeder is
  -- opened: a requested table change takes the next unreserved chair on a
  -- table that is not Main 1, oldest request first; two requests that would
  -- take each other's table are swapped.
  v_n := public.fn_cash_seat_change_plan(g.id, v_now);
  IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('seat_changes_planned', v_n); END IF;

  -- ── 3. OPEN (18.3) ───────────────────────────────────────────────────────
  SELECT coalesce(sum(c.open_unreserved), 0) INTO v_open_unreserved
    FROM unnest(v_census) c WHERE c.lifecycle IN ('live', 'opening') AND NOT c.breaking;
  SELECT count(*) INTO v_waiting FROM public.cash_game_waitlist w
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified');
  v_buyers := v_waiting + GREATEST(coalesce(p_eligible_horses, 0), 0);
  -- (a CASE ... THEN inside an IF condition ends the condition early in
  --  PL/pgSQL, so the cap is computed first)
  v_table_cap := g.cap_mains + 1;
  IF g.allow_second_feeder THEN v_table_cap := v_table_cap + 1; END IF;

  IF g.enabled AND v_open_unreserved = 0 AND v_live_tables > 0
     AND NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.lifecycle = 'opening')
     AND v_live_tables < v_table_cap
     -- Two minutes after a feeder was abandoned, not before.
     AND NOT EXISTS (SELECT 1 FROM public.cash_cluster_events e
                      WHERE e.game_id = g.id AND e.kind = 'feeder_abandoned' AND e.at > v_now - interval '2 minutes') THEN
    IF v_buyers >= 2 THEN
      UPDATE public.tables SET promote_pending = true
       WHERE cluster_id = g.id AND role = 'feeder' AND lifecycle = 'live';
      PERFORM public.fn_cash_cluster_open_table(g.id, 'feeder', NULL, 'opening', NULL);
      UPDATE public.cash_games SET opening_hold_since = NULL WHERE id = g.id;
      v_actions := v_actions || jsonb_build_object('feeder', 'opened', 'buyers', v_buyers);
    ELSIF v_buyers = 1 THEN
      -- One buyer holds for 60 s; the fleet's next cycle usually brings a
      -- partner. No ghost table.
      -- AN EXPIRED HOLD RESTS (2026-09-05): five minutes before the next.
      IF g.opening_hold_since IS NULL
         AND (g.opening_hold_rested_until IS NULL OR g.opening_hold_rested_until <= v_now) THEN
        UPDATE public.cash_games SET opening_hold_since = v_now WHERE id = g.id;
        INSERT INTO public.cash_cluster_events (game_id, kind) VALUES (g.id, 'table_opening_hold');
        v_actions := v_actions || jsonb_build_object('opening_hold', 'started');
      ELSIF g.opening_hold_since IS NOT NULL AND g.opening_hold_since < v_now - interval '60 seconds' THEN
        UPDATE public.cash_games SET opening_hold_since = NULL, opening_hold_rested_until = v_now + interval '5 minutes' WHERE id = g.id;
        INSERT INTO public.cash_cluster_events (game_id, kind) VALUES (g.id, 'table_opening_hold_expired');
        v_actions := v_actions || jsonb_build_object('opening_hold', 'expired');
      END IF;
    END IF;
  ELSIF g.opening_hold_since IS NOT NULL THEN
    UPDATE public.cash_games SET opening_hold_since = NULL WHERE id = g.id;
  END IF;

  -- ── 4. PROMOTE (18.3) ────────────────────────────────────────────────────
  -- An opening feeder with two seated is live. The feeder before it, marked
  -- promote_pending, becomes Main N+1.
  FOR t IN SELECT * FROM unnest(v_census) c WHERE c.lifecycle = 'opening' AND c.seated >= 2 LOOP
    UPDATE public.tables SET lifecycle = 'live', live_at = v_now WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'feeder_live');
    SELECT coalesce(max(main_index), 0) + 1 INTO v_idx FROM public.tables
     WHERE cluster_id = g.id AND role = 'main' AND lifecycle <> 'closed' AND coalesce(is_deleted, false) = false;
    FOR v_prev_feeder IN SELECT id, name FROM public.tables
                          WHERE cluster_id = g.id AND role = 'feeder' AND promote_pending AND id <> t.id
                            AND lifecycle = 'live' ORDER BY created_at
    LOOP
      UPDATE public.tables SET role = 'main', main_index = v_idx, promote_pending = false,
             name = left(g.name, 50) || ' Main ' || v_idx
       WHERE id = v_prev_feeder.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, v_prev_feeder.id, 'feeder_promoted_to_main', jsonb_build_object('main_index', v_idx));
      v_idx := v_idx + 1;
    END LOOP;
    v_actions := v_actions || jsonb_build_object('feeder_live', t.id);
  END LOOP;

  -- Refresh the census for the steps that read roles (the counts are the
  -- tick's own snapshot and stay).
  SELECT coalesce(array_agg(
           (tb.id, tb.role, tb.main_index, tb.lifecycle, c.status, c.created_at, c.max_players,
            c.seated, c.reserved, c.open_unreserved, c.breaking)::public.cash_cluster_census_row
           ORDER BY c.created_at), '{}'::public.cash_cluster_census_row[])
    INTO v_census
    FROM unnest(v_census) c JOIN public.tables tb ON tb.id = c.id;

  -- ── 5. BREAK (18.3) ──────────────────────────────────────────────────────
  -- Candidate: newest table first (feeder, then the highest main), never
  -- Main 1, never a table still opening. Condition: everyone fits in the
  -- rest at or above the floor. It breaks when that has held for the
  -- SHORTER of two completed orbits on the candidate or five minutes
  -- (OPORD 1.4 18.3). An orbit is one hand per seated player; a table
  -- with fewer than two seated deals no hands, so only the clock runs
  -- for it. Until 2026-09-05 only the clock ran for everyone, and a
  -- six-handed feeder that dealt twenty hands in four minutes with the
  -- whole game fitting elsewhere still sat there for the fifth.
  v_floor := CASE WHEN g.handedness <= 6 THEN 3 ELSE 4 END;
  SELECT * INTO v_candidate FROM unnest(v_census) c
   WHERE NOT (c.role = 'main' AND c.main_index = 1) AND c.lifecycle = 'live'
   ORDER BY (c.role = 'feeder') DESC, c.main_index DESC NULLS FIRST, c.created_at DESC LIMIT 1;

  IF NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.breaking) AND v_candidate.id IS NOT NULL THEN
    SELECT coalesce(sum(c.max_players - c.reserved), 0), count(*) INTO v_remaining_capacity, v_remaining_tables
      FROM unnest(v_census) c WHERE c.id <> v_candidate.id AND c.lifecycle = 'live';
    IF v_remaining_tables >= 1
       -- STRICT (2026-09-05, first live cycle): everyone fits AND the rest
       -- keeps a seat open. At `<=` the rest is exactly full at the moment
       -- of the break, which is the OPEN rule's own trigger (no unreserved
       -- seat), so the feeder was broken and re-opened 7 s apart.
       AND v_seated_total < v_remaining_capacity
       AND v_seated_total >= v_floor * v_remaining_tables THEN
      SELECT break_eligible_since INTO r FROM public.tables WHERE id = v_candidate.id;
      IF r.break_eligible_since IS NULL THEN
        UPDATE public.tables SET break_eligible_since = v_now WHERE id = v_candidate.id;
        v_actions := v_actions || jsonb_build_object('break_eligible', v_candidate.id);
      ELSE
        v_orbit := v_candidate.seated;
        v_hands := 0;
        IF v_orbit >= 2 THEN
          SELECT count(*) INTO v_hands FROM public.hand_history h
           WHERE h.table_id = v_candidate.id AND h.created_at >= r.break_eligible_since;
        END IF;
        IF r.break_eligible_since <= v_now - interval '5 minutes'
           OR (v_orbit >= 2 AND v_hands >= 2 * v_orbit) THEN
          UPDATE public.tables SET lifecycle = 'breaking', break_started_at = v_now, break_eligible_since = NULL
           WHERE id = v_candidate.id;
          SELECT coalesce(array_agg(
                   (c.id, c.role, c.main_index,
                    CASE WHEN c.id = v_candidate.id THEN 'breaking' ELSE c.lifecycle END,
                    c.status, c.created_at, c.max_players, c.seated, c.reserved, c.open_unreserved,
                    c.breaking OR c.id = v_candidate.id)::public.cash_cluster_census_row
                   ORDER BY c.created_at), '{}'::public.cash_cluster_census_row[])
            INTO v_census FROM unnest(v_census) c;
          INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
          VALUES (g.id, v_candidate.id, 'table_break_started',
                  jsonb_build_object('seated_total', v_seated_total, 'remaining_capacity', v_remaining_capacity,
                                     'eligible_since', r.break_eligible_since, 'hands_since_eligible', v_hands, 'orbit', v_orbit));
          v_actions := v_actions || jsonb_build_object('break_started', v_candidate.id,
                                                       'hands_since_eligible', v_hands, 'orbit', v_orbit);
        END IF;
      END IF;
    ELSE
      UPDATE public.tables SET break_eligible_since = NULL
       WHERE cluster_id = g.id AND break_eligible_since IS NOT NULL;
    END IF;
  ELSE
    UPDATE public.tables SET break_eligible_since = NULL
     WHERE cluster_id = g.id AND break_eligible_since IS NOT NULL;
  END IF;

  -- A breaking table: every seated player is planned onto the shortest live
  -- table with room (must-move already took the mains' open seats above;
  -- this covers what is left, feeder included). When the last chair is
  -- empty it closes.
  FOR t IN SELECT * FROM unnest(v_census) c WHERE c.breaking LOOP
    IF t.seated = 0 THEN
      UPDATE public.tables SET status = 'closed', lifecycle = 'closed', current_players = 0, updated_at = now()
       WHERE id = t.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'table_break_completed');
      SELECT coalesce(array_agg(c ORDER BY c.created_at), '{}'::public.cash_cluster_census_row[])
        INTO v_census FROM unnest(v_census) c WHERE c.id <> t.id;
      v_actions := v_actions || jsonb_build_object('closed', t.id);
      CONTINUE;
    END IF;
    -- A SECOND CHAIR IN ONE GAME (2026-09-05). Before the door refused it, the
    -- fleet could seat the same horse at two tables of one game; found live
    -- with one of the two chairs on this breaking table. There is nowhere to
    -- move that chair to (they are already at the other table), so it goes
    -- home: the stack returns to the wallet through the forced cash-out the
    -- table-close path uses. Nothing is lost; the other chair is untouched.
    FOR r IN SELECT ts.user_id, ts.seat_number, ts.stack,
                    coalesce(ts.club_id, public.fn_player_home_club(ts.user_id, NULL)) AS club_id
               FROM public.table_seats ts
              WHERE ts.table_id = t.id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
                AND coalesce(ts.stack, 0) > 0
                AND EXISTS (SELECT 1 FROM public.table_seats o JOIN public.tables ot ON ot.id = o.table_id
                             WHERE o.user_id = ts.user_id AND o.left_at IS NULL AND o.table_id <> t.id
                               AND ot.cluster_id = g.id AND ot.lifecycle IN ('live', 'opening'))
    LOOP
      CONTINUE WHEN r.club_id IS NULL;
      -- The same three calls fn_cashout_seats_for_closing_table makes, per seat.
      PERFORM public.fn_ensure_club_wallet(r.user_id, r.club_id);
      PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', t.id);
      v_res := public.atomic_seat_cashout_locked(r.user_id, t.id, r.seat_number, 'forced');
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, t.id, 'second_chair_cashed_out',
              jsonb_build_object('player_id', r.user_id, 'seat', r.seat_number, 'stack', r.stack,
                                 'club_id', r.club_id, 'credited', v_res->'credited', 'key', v_res->'idempotency_key'));
      v_actions := v_actions || jsonb_build_object('second_chair_cashed_out', r.user_id);
    END LOOP;
    FOR r IN SELECT ts.user_id FROM public.table_seats ts
              WHERE ts.table_id = t.id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
                AND coalesce(ts.stack, 0) > 0
                AND coalesce(ts.leave_pending, false) = false
                AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'pending')
                AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'cancelled' AND m.created_at > v_now - interval '60 seconds')
              ORDER BY coalesce((SELECT r2.joined_at FROM public.cash_game_roster r2
                                  WHERE r2.game_id = g.id AND r2.user_id = ts.user_id AND r2.left_at IS NULL), ts.joined_at),
                       ts.joined_at
    LOOP
      SELECT c.id INTO v_shortest FROM unnest(v_census) c
       WHERE c.id <> t.id AND NOT c.breaking AND c.lifecycle IN ('live', 'opening')
         AND c.open_unreserved - (SELECT count(*) FROM public.cash_seat_moves m WHERE m.to_table_id = c.id AND m.state = 'pending' AND m.swap_move_id IS NULL) > 0
         AND NOT EXISTS (SELECT 1 FROM public.table_seats d WHERE d.table_id = c.id AND d.user_id = r.user_id AND d.left_at IS NULL)
       ORDER BY c.seated ASC, c.main_index ASC NULLS LAST LIMIT 1;
      EXIT WHEN v_shortest IS NULL;
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason)
      VALUES (g.id, r.user_id, t.id, v_shortest, 'break');
      v_moves := v_moves + 1;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, v_shortest, 'move_planned', jsonb_build_object('player_id', r.user_id, 'from_table_id', t.id, 'reason', 'break'));
    END LOOP;
  END LOOP;

  -- ── 6. ROLES (1.3 s9.2) ──────────────────────────────────────────────────
  -- Oldest live table is Main 1; mains renumber by age; with no feeder left
  -- and two or more tables, the newest becomes the feeder.
  -- A GAME WITH A FEEDER AND NO MAIN (2026-09-05). Found live: Main 1 closed
  -- by status under a disabled game, five players still on its feeder, and
  -- nothing below promoted the feeder because this step only renumbers
  -- mains. Oldest live table is Main 1 (1.3 s9.2); if no main is live, the
  -- oldest live feeder becomes it, so the players on it have a Main to be
  -- on and the R3 repair does not open a second table beside them.
  IF NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.lifecycle IN ('live', 'opening') AND c.role = 'main')
     AND EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.lifecycle = 'live' AND c.role = 'feeder') THEN
    SELECT * INTO t FROM unnest(v_census) c WHERE c.lifecycle = 'live' AND c.role = 'feeder' ORDER BY c.created_at LIMIT 1;
    UPDATE public.tables SET role = 'main', main_index = 1, promote_pending = false, name = g.name WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
    VALUES (g.id, t.id, 'feeder_promoted_to_main', jsonb_build_object('main_index', 1, 'reason', 'no_live_main'));
    SELECT coalesce(array_agg(
             (c.id, CASE WHEN c.id = t.id THEN 'main' ELSE c.role END, CASE WHEN c.id = t.id THEN 1 ELSE c.main_index END,
              c.lifecycle, c.status, c.created_at, c.max_players, c.seated, c.reserved, c.open_unreserved, c.breaking)::public.cash_cluster_census_row
             ORDER BY c.created_at), '{}'::public.cash_cluster_census_row[])
      INTO v_census FROM unnest(v_census) c;
    v_actions := v_actions || jsonb_build_object('feeder_became_main1', t.id);
  END IF;
  v_idx := 0;
  FOR t IN SELECT * FROM unnest(v_census) c WHERE c.lifecycle IN ('live', 'opening') AND c.role = 'main' ORDER BY c.created_at LOOP
    v_idx := v_idx + 1;
    IF t.main_index IS DISTINCT FROM v_idx THEN
      UPDATE public.tables SET main_index = v_idx,
             name = CASE WHEN v_idx = 1 THEN g.name ELSE left(g.name, 50) || ' Main ' || v_idx END
       WHERE id = t.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, t.id, 'main_renumbered', jsonb_build_object('from', t.main_index, 'to', v_idx));
    END IF;
  END LOOP;
  IF v_idx >= 2 AND NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.role = 'feeder' AND c.lifecycle IN ('live', 'opening')) THEN
    SELECT * INTO t FROM unnest(v_census) c WHERE c.role = 'main' AND c.lifecycle = 'live' ORDER BY c.created_at DESC LIMIT 1;
    UPDATE public.tables SET role = 'feeder', main_index = NULL, promote_pending = false,
           name = left(g.name, 50) || ' Feeder'
     WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'main_demoted_to_feeder');
    v_actions := v_actions || jsonb_build_object('demoted', t.id);
  END IF;

  -- ── enabled = false (18.4): no seeding, no opening; empties close ─────────
  IF NOT g.enabled THEN
    FOR t IN SELECT * FROM unnest(v_census) c WHERE c.seated = 0 LOOP
      UPDATE public.tables SET status = 'closed', lifecycle = 'closed', current_players = 0, updated_at = now() WHERE id = t.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'table_closed_disabled');
      v_actions := v_actions || jsonb_build_object('closed_disabled', t.id);
    END LOOP;
  END IF;

  -- ── 7. WAKE / SLEEP (18.4) ───────────────────────────────────────────────
  v_new_state := CASE WHEN v_seated_total = 0 AND coalesce(p_eligible_horses, 0) = 0 THEN 'dormant' ELSE 'live' END;
  IF g.enabled AND g.state IS DISTINCT FROM v_new_state THEN
    UPDATE public.cash_games SET state = v_new_state, updated_at = now() WHERE id = g.id;
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (g.id, CASE WHEN v_new_state = 'live' THEN 'game_woken' ELSE 'game_dormant' END,
            jsonb_build_object('seated_total', v_seated_total, 'eligible_horses', p_eligible_horses));
    v_actions := v_actions || jsonb_build_object('state', v_new_state);
  END IF;

  UPDATE public.cash_games SET last_tick_at = v_now, last_tick_actions = v_actions WHERE id = g.id;

  RETURN jsonb_build_object('ok', true, 'game_id', g.id, 'seated_total', v_seated_total,
                            'tables', v_live_tables, 'buyers', v_buyers, 'actions', v_actions);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) TO service_role;

DO $post$
DECLARE v_md5 text; v_src text;
BEGIN
  SELECT md5(p.prosrc), p.prosrc INTO v_md5, v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_cash_cluster_tick';
  IF v_md5 <> 'bf55d7a456afba498070a3d6e62c2002' THEN
    RAISE EXCEPTION 'fn_cash_cluster_tick body after apply is %, expected bf55d7a456afba498070a3d6e62c2002', v_md5;
  END IF;
  IF position('THE LOOKUP READS THE LIVE BOARD' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_cash_cluster_tick R3 still reads the oldest row';
  END IF;
END
$post$;

COMMIT;
