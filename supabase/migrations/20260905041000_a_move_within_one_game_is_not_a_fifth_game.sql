-- ═══════════════════════════════════════════════════════════════════════════════
-- A MOVE WITHIN ONE GAME IS NOT A FIFTH GAME, AND A REFUSED MOVE GETS A MINUTE
-- (Operation Table Stakes, first live self-heal; 2026-09-05 00:00 UTC)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 20260905040000 turned the closed NLH 0.10/0.25 Madness feeder back into
-- `breaking` and the tick planned its one player onto Main 1 at 00:00:06. The
-- engine executed the move at once and the seat insert on Main 1 was refused:
--
--     FOUR TABLE LIMIT: user a7bdfc35-… is already committed to 4 games
--
-- Two defects, one visible in the note and one in the event log.
--
-- 1. THE COUNT. `fn_enforce_four_table_limit` counts the player's live seats
--    at every table whose status is not `closed` - including the seat on the
--    BREAKING table they are being moved OFF. A must-move or break move is
--    one player changing chairs inside one game; it never adds a game. The
--    trigger now subtracts the player's other live seats in the destination
--    table's own cluster. Fleet and tournament seats are unaffected
--    (cluster_id is NULL there, nothing is subtracted).
--
-- 2. THE CHURN. The planner skips a player with a PENDING move. A refused
--    move is `cancelled`, not pending, so the same player was re-planned on
--    every 5 s tick - 14 rows in the first 70 s, ~17,000 a day per stuck
--    player - each one a seat insert the engine attempted and the trigger
--    refused. The planner (must-move and break alike) now leaves a player
--    alone for 60 s after a cancelled move: long enough for whatever refused
--    it to change, short enough that nobody notices the wait.
--
-- The tick body is 20260905040000's plus exactly the two back-off predicates;
-- the assertions pin all three edits.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The four-table count does not count the chair being left
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_enforce_four_table_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_live       int;
  v_is_closed  boolean;
  v_tournament uuid;
  v_cluster    uuid;
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT (t.status = 'closed'), t.tournament_id, t.cluster_id
    INTO v_is_closed, v_tournament, v_cluster
    FROM public.tables t
   WHERE t.id = NEW.table_id;
  IF COALESCE(v_is_closed, false) THEN
    RETURN NEW;
  END IF;

  -- A MOVE WITHIN ONE GAME IS NOT A FIFTH GAME (2026-09-05). A player who
  -- already holds a live seat on another table of this same must-move game
  -- (the feeder or breaking table they are leaving) is changing chairs, not
  -- entering a game. The cap does not apply to a move at all: refusing one
  -- strands the player on a breaking table, which is worse than anything
  -- the cap protects (the horse this was found on held 5 - two seats and
  -- three bookings - so subtracting the chair being left was not enough).
  IF v_cluster IS NOT NULL AND EXISTS (
       SELECT 1
         FROM public.table_seats ts
         JOIN public.tables t ON t.id = ts.table_id
        WHERE ts.user_id = NEW.user_id
          AND ts.left_at IS NULL
          AND t.status <> 'closed'
          AND t.cluster_id = v_cluster
          AND t.id <> NEW.table_id) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || NEW.user_id::text, 0));

  v_live := public.fn_concurrent_game_load(NEW.user_id, NEW.id, NEW.table_id, v_tournament);

  IF v_live >= 4 THEN
    RAISE EXCEPTION
      'FOUR TABLE LIMIT: user % is already committed to % games and may not take another',
      NEW.user_id, v_live
      USING ERRCODE = '23514',
            HINT = 'Leave a table or unregister before joining another. A game is a live seat or a booking for a tournament that has not started. This limit applies to players and horses alike.';
  END IF;

  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The closed-table door also watches a REVIVED seat row
-- ─────────────────────────────────────────────────────────────────────────────
-- 20260905040000's guard is BEFORE INSERT. table_seats keeps departed rows and
-- (table_id, seat_number) is unique, so most sit-downs are an UPDATE that
-- sets left_at back to NULL - the four-table guard has always fired on that
-- too. Same shape as zz_restriction_seat_revive_guard.

DROP TRIGGER IF EXISTS trg_refuse_seat_revive_on_closed_cluster_table ON public.table_seats;
CREATE TRIGGER trg_refuse_seat_revive_on_closed_cluster_table
  BEFORE UPDATE OF user_id, left_at, table_id ON public.table_seats
  FOR EACH ROW
  WHEN (NEW.left_at IS NULL AND (OLD.left_at IS NOT NULL OR OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.table_id IS DISTINCT FROM NEW.table_id))
  EXECUTE FUNCTION public.fn_refuse_seat_on_closed_cluster_table();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The tick: a refused move gets a minute before it is planned again
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick(p_game_id uuid, p_eligible_horses integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
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

  v_census := public.fn_cash_cluster_census(g.id, v_now);
  SELECT coalesce(sum(c.seated), 0), count(*) INTO v_seated_total, v_live_tables FROM unnest(v_census) c;

  -- R3: an enabled game always has Main 1 open. Anything that closed it
  -- (a stray close, the pre-controller lifecycle pass, a restart) is undone
  -- here rather than by a row flag.
  SELECT * INTO v_main1 FROM public.tables
   WHERE cluster_id = g.id AND role = 'main' AND main_index = 1 AND coalesce(is_deleted, false) = false
   ORDER BY created_at LIMIT 1;
  IF g.enabled AND (v_main1.id IS NULL OR v_main1.status NOT IN ('waiting', 'running', 'active') OR v_main1.lifecycle = 'closed') THEN
    IF v_main1.id IS NULL OR v_main1.lifecycle = 'closed' THEN
      PERFORM public.fn_cash_cluster_open_table(g.id, 'main', 1, 'live', NULL);
      v_actions := v_actions || jsonb_build_object('main1', 'opened');
    ELSE
      UPDATE public.tables SET status = 'waiting', lifecycle = 'live', current_players = 0, updated_at = now()
       WHERE id = v_main1.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, v_main1.id, 'main1_reopened');
      v_actions := v_actions || jsonb_build_object('main1', 'reopened');
    END IF;
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
         - (SELECT count(*) FROM public.cash_seat_moves m WHERE m.to_table_id = t.id AND m.state = 'pending');
    FOR r IN
      SELECT ts.user_id, ts.table_id
        FROM public.table_seats ts
        JOIN unnest(v_census) c ON c.id = ts.table_id
       WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
         AND (c.role = 'feeder' OR c.breaking)
         AND c.id <> t.id
         AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'pending')
         -- BACK-OFF (2026-09-05): a move the engine just refused (cancelled
         -- with a note) is not re-planned every 5 s; the refusal gets a minute.
         AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'cancelled' AND m.created_at > v_now - interval '60 seconds')
       ORDER BY c.breaking DESC, ts.joined_at ASC
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
     AND v_live_tables < v_table_cap THEN
    IF v_buyers >= 2 THEN
      UPDATE public.tables SET promote_pending = true
       WHERE cluster_id = g.id AND role = 'feeder' AND lifecycle = 'live';
      PERFORM public.fn_cash_cluster_open_table(g.id, 'feeder', NULL, 'opening', NULL);
      UPDATE public.cash_games SET opening_hold_since = NULL WHERE id = g.id;
      v_actions := v_actions || jsonb_build_object('feeder', 'opened', 'buyers', v_buyers);
    ELSIF v_buyers = 1 THEN
      -- One buyer holds for 60 s; the fleet's next cycle usually brings a
      -- partner. No ghost table.
      IF g.opening_hold_since IS NULL THEN
        UPDATE public.cash_games SET opening_hold_since = v_now WHERE id = g.id;
        INSERT INTO public.cash_cluster_events (game_id, kind) VALUES (g.id, 'table_opening_hold');
        v_actions := v_actions || jsonb_build_object('opening_hold', 'started');
      ELSIF g.opening_hold_since < v_now - interval '60 seconds' THEN
        UPDATE public.cash_games SET opening_hold_since = NULL WHERE id = g.id;
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
  -- rest at or above the floor. Five minutes of that, then it breaks.
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
      ELSIF r.break_eligible_since <= v_now - interval '5 minutes' THEN
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
                jsonb_build_object('seated_total', v_seated_total, 'remaining_capacity', v_remaining_capacity));
        v_actions := v_actions || jsonb_build_object('break_started', v_candidate.id);
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
    FOR r IN SELECT ts.user_id FROM public.table_seats ts
              WHERE ts.table_id = t.id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'pending')
                AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'cancelled' AND m.created_at > v_now - interval '60 seconds')
              ORDER BY ts.joined_at
    LOOP
      SELECT c.id INTO v_shortest FROM unnest(v_census) c
       WHERE c.id <> t.id AND NOT c.breaking AND c.lifecycle IN ('live', 'opening')
         AND c.open_unreserved - (SELECT count(*) FROM public.cash_seat_moves m WHERE m.to_table_id = c.id AND m.state = 'pending') > 0
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
$$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Assertions
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE src text; n int;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'fn_cash_cluster_tick' AND pronamespace = 'public'::regnamespace;
  SELECT count(*) INTO n FROM regexp_matches(src, 'm\.state = ''cancelled'' AND m\.created_at > v_now - interval ''60 seconds''', 'g');
  IF n <> 2 THEN
    RAISE EXCEPTION 'fn_cash_cluster_tick should back off a cancelled move in both planners (found % of 2)', n;
  END IF;
  IF src NOT LIKE '%v_seated_total < v_remaining_capacity%' OR src NOT LIKE '%closed_table_reopened_to_break%' THEN
    RAISE EXCEPTION 'fn_cash_cluster_tick lost an edit from 20260905040000';
  END IF;
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'fn_enforce_four_table_limit' AND pronamespace = 'public'::regnamespace;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_refuse_seat_revive_on_closed_cluster_table' AND tgrelid = 'public.table_seats'::regclass) THEN
    RAISE EXCEPTION 'the revive door is missing';
  END IF;
  IF src NOT LIKE '%AND t.cluster_id = v_cluster%' OR src NOT LIKE '%A MOVE WITHIN ONE GAME IS NOT A FIFTH GAME%' THEN
    RAISE EXCEPTION 'fn_enforce_four_table_limit still counts the chair being left';
  END IF;
END $$;

COMMIT;
