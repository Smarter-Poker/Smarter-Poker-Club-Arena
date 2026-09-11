-- ═══════════════════════════════════════════════════════════════════════════
-- THE CLUSTER BOARDS: every shape that broke fn_cash_cluster_tick this week,
-- replayed against production and ROLLED BACK.
-- ───────────────────────────────────────────────────────────────────────────
-- WHAT THIS IS. fn_cash_cluster_tick was fixed seven times between
-- 2026-09-05 03:50 and 15:05 CDT, every time from a board found live, and
-- every fix was proven the same way: a hand-written psql transaction that
-- built the board, ran the tick, read the result and rolled back
-- (docs/changelog/2026-09-05-the-break-counts-orbits-not-only-minutes.md,
-- "How it was proven"). Those transactions lived in scrollback. This file is
-- them, written down, so the next change to the tick runs all ten in one
-- command:  npm run probe:cluster
--
-- WHY IT IS NOT VITEST. The tick is PL/pgSQL, 36 KB of it, driven by a
-- census function, a dozen BEFORE/AFTER triggers on tables and table_seats
-- (the closed-table door, the one-chair-per-game door, the four-table limit,
-- the seated-table close guard, the auto-cashout on close) and the real
-- ruleset snapshots. None of that can be loaded into vitest; a TypeScript
-- reimplementation of it would prove the reimplementation. The only thing
-- that proves the tick is the tick, on the real schema, against real games.
--
-- EVERYTHING ROLLS BACK. Each board is its own BEGIN ... ROLLBACK. A board
-- asserts with RAISE EXCEPTION inside a DO block, so a failed expectation
-- aborts psql (ON_ERROR_STOP) with the open transaction rolled back by the
-- server when the session ends. Nothing here is committed on any path:
-- there is no COMMIT in this file, and the shell wrapper refuses to run it
-- without ON_ERROR_STOP. Helpers live in pg_temp (CLAUDE.md 11.5 rule 4) and
-- vanish with the session.
--
-- WHAT A BOARD MAY TOUCH. A REAL enabled must-move game, chosen by query at
-- run time. Boards that need players build them on a DORMANT game (Main 1
-- open, nobody seated) so that the row lock the tick takes on cash_games
-- never stalls a game people are playing; the two boards that must read a
-- live game (the second chair, the headcount column) hold their transaction
-- for well under a second. Writes are limited to: tables rows of the chosen
-- game (status, lifecycle, max_players, break_eligible_since,
-- current_players), table_seats ONLY by INSERT of copies of live seats (so
-- every door trigger is exercised and a refusal is data, not a failure),
-- synthetic hand_history rows (a copy of a real row with a new id, the
-- candidate table_id, an empty player list and a small hand_number so the
-- global-hand-number unique index is never touched), and new cluster
-- tables through the controller's own fn_cash_cluster_open_table. Never
-- clubs, wallets or chip balances: the one board that reaches a wallet
-- (the second chair cash-out) does so through the tick's own path and is
-- rolled back with everything else. Section 11.5 of CLAUDE.md is the rule;
-- scripts/dev/probe-rpc.sql section 1 is the shape.
--
-- WHEN NOT TO RUN IT. During the :53-:00 maintenance freeze the tick
-- returns {skipped: frozen} and every board would fail for the wrong
-- reason; the preamble checks fn_platform_frozen() and stops first.
--
-- RUN:  bash scripts/dev/probe-cluster-boards.sh     (or npm run probe:cluster)
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
\set QUIET on
\pset pager off
\timing off
\set QUIET off

\echo
\echo ================================================================
\echo  fn_cash_cluster_tick: the ten boards (all rolled back)
\echo ================================================================

-- ── helpers (pg_temp: session-scoped, gone at disconnect, never public) ────
CREATE FUNCTION pg_temp.ok(p boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(p, false) THEN RAISE NOTICE 'PASS  %', msg;
  ELSE RAISE EXCEPTION 'FAIL  %', msg; END IF;
END $$;

-- A dormant, enabled must-move game on a house board: Main 1 live and
-- waiting, nobody seated, nothing pending. Fresh players are copied onto it.
CREATE FUNCTION pg_temp.pick_dormant_game() RETURNS uuid LANGUAGE sql AS $$
  SELECT g.id FROM public.cash_games g
   WHERE g.must_move AND g.enabled AND g.state = 'dormant'
     AND public.fn_ca_house_board_allows_automation(g.club_id)
     AND g.opening_hold_since IS NULL
     AND (SELECT count(*) FROM public.tables t WHERE t.cluster_id = g.id AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false) = 1
     AND EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = g.id AND t.lifecycle = 'live' AND t.status = 'waiting'
                    AND t.role = 'main' AND t.main_index = 1 AND coalesce(t.is_deleted, false) = false
                    AND NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = t.id AND ts.left_at IS NULL))
     AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.game_id = g.id AND m.state = 'pending')
     AND NOT EXISTS (SELECT 1 FROM public.cash_game_waitlist w WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified'))
     AND NOT EXISTS (SELECT 1 FROM public.cash_cluster_events e WHERE e.game_id = g.id AND e.kind = 'feeder_abandoned' AND e.at > now() - interval '2 minutes')
   ORDER BY g.last_tick_at NULLS FIRST, g.created_at
   LIMIT 1
$$;

CREATE FUNCTION pg_temp.main1(p_game uuid) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.tables WHERE cluster_id = p_game AND role = 'main' AND main_index = 1
     AND lifecycle <> 'closed' AND coalesce(is_deleted, false) = false ORDER BY created_at LIMIT 1
$$;

-- Copies a REAL live seat from another game onto (p_table, p_seat): a player
-- who holds exactly one live seat anywhere and none in this game. Every door
-- trigger on table_seats runs; a refusal (VPIP bar, club, limit) moves to the
-- next candidate. p_age orders seniority: older sits first.
CREATE FUNCTION pg_temp.seat_copy(p_table uuid, p_seat integer, p_age interval DEFAULT interval '0')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_game uuid; c record; v_tried integer := 0; v_err text;
BEGIN
  SELECT cluster_id INTO v_game FROM public.tables WHERE id = p_table;
  FOR c IN
    SELECT ts.* FROM public.table_seats ts
      JOIN public.tables t ON t.id = ts.table_id
     WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL AND coalesce(ts.stack, 0) > 0
       AND t.cluster_id IS NOT NULL AND t.cluster_id <> v_game AND t.lifecycle <> 'closed'
       AND coalesce(ts.leave_pending, false) = false
       AND (SELECT count(*) FROM public.table_seats o WHERE o.user_id = ts.user_id AND o.left_at IS NULL) = 1
       AND NOT EXISTS (SELECT 1 FROM public.table_seats o JOIN public.tables ot ON ot.id = o.table_id
                        WHERE o.user_id = ts.user_id AND o.left_at IS NULL AND ot.cluster_id = v_game)
       AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'pending')
       -- the four-table limit counts tournament bookings too; ask it first
       AND public.fn_concurrent_game_load(ts.user_id, NULL, NULL, NULL) < 4
     ORDER BY ts.joined_at DESC LIMIT 40
  LOOP
    v_tried := v_tried + 1;
    BEGIN
      INSERT INTO public.table_seats
      SELECT (jsonb_populate_record(NULL::public.table_seats,
                to_jsonb(c) || jsonb_build_object(
                  'id', gen_random_uuid(), 'table_id', p_table, 'seat_number', p_seat,
                  'joined_at', clock_timestamp() - p_age, 'club_id', NULL,
                  'leave_pending', false, 'entry_hold', NULL, 'is_sitting_out', false, 'is_away', false,
                  'sit_out_at', NULL, 'scheduled_leave_hands', NULL, 'status', 'active'))).*;
      RETURN c.user_id;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      RAISE NOTICE '      (door refused candidate %: %)', v_tried, left(v_err, 90);
    END;
  END LOOP;
  RAISE EXCEPTION 'seat_copy: no candidate could be seated at % seat % after % tries', p_table, p_seat, v_tried;
END $$;

-- n synthetic hands on p_table since p_since: copies of a real recent hand
-- with a new id, this table, no players (so the stats triggers have nothing
-- to attribute) and a hand_number below the global unique range.
CREATE FUNCTION pg_temp.hands(p_table uuid, p_n integer, p_since timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE src public.hand_history; i integer;
BEGIN
  SELECT h.* INTO src FROM public.hand_history h
   WHERE h.tournament_id IS NULL AND h.created_at > now() - interval '1 day' ORDER BY h.created_at DESC LIMIT 1;
  IF src.id IS NULL THEN RAISE EXCEPTION 'hands: no cash hand in the last day to copy'; END IF;
  FOR i IN 1..p_n LOOP
    INSERT INTO public.hand_history
    SELECT (jsonb_populate_record(NULL::public.hand_history,
              to_jsonb(src) || jsonb_build_object(
                'id', gen_random_uuid(), 'table_id', p_table, 'hand_number', i,
                'created_at', p_since + (i * interval '2 seconds'),
                'started_at', p_since + (i * interval '2 seconds'), 'ended_at', p_since + (i * interval '2 seconds'),
                'players', '[]'::jsonb, 'winners', '[]'::jsonb, 'actions', '[]'::jsonb, 'winners_by_board', NULL,
                'showdown', NULL, 'pots', NULL, 'bomb_pot', NULL, 'daily_mission_events', NULL,
                'rake_amount', 0, 'bbj_amount', 0, 'has_human', false, 'reported', false, 'reported_at', NULL,
                'summary', 'probe-cluster-boards synthetic hand'))).*;
  END LOOP;
END $$;

CREATE FUNCTION pg_temp.tick(p_game uuid, p_horses integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  r := public.fn_cash_cluster_tick(p_game, p_horses);
  IF (r->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'tick did not run: %', r;
  END IF;
  RAISE NOTICE '      tick: seated=% tables=% actions=%', r->>'seated_total', r->>'tables', r->'actions';
  RETURN r;
END $$;

CREATE FUNCTION pg_temp.events(p_game uuid, p_kind text, p_table uuid DEFAULT NULL) RETURNS integer LANGUAGE sql AS $$
  SELECT count(*)::integer FROM public.cash_cluster_events e
   WHERE e.game_id = p_game AND e.kind = p_kind AND e.at >= now()   -- now() = this transaction's start
     AND (p_table IS NULL OR e.table_id = p_table)
$$;

-- A second dormant game, for a board that needs two.
CREATE FUNCTION pg_temp.pick_dormant_game_except(p_not uuid) RETURNS uuid LANGUAGE sql AS $$
  SELECT g.id FROM public.cash_games g
   WHERE g.must_move AND g.enabled AND g.state = 'dormant' AND g.id <> p_not
     AND public.fn_ca_house_board_allows_automation(g.club_id)
     AND g.opening_hold_since IS NULL
     AND (SELECT count(*) FROM public.tables t WHERE t.cluster_id = g.id AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false) = 1
     AND EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = g.id AND t.lifecycle = 'live' AND t.status = 'waiting'
                    AND t.role = 'main' AND t.main_index = 1 AND coalesce(t.is_deleted, false) = false
                    AND NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = t.id AND ts.left_at IS NULL))
     AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.game_id = g.id AND m.state = 'pending')
     AND NOT EXISTS (SELECT 1 FROM public.cash_game_waitlist w WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified'))
     AND NOT EXISTS (SELECT 1 FROM public.cash_cluster_events e WHERE e.game_id = g.id AND e.kind = 'feeder_abandoned' AND e.at > now() - interval '2 minutes')
   ORDER BY g.last_tick_at NULLS FIRST, g.created_at
   LIMIT 1
$$;

-- Seats p_n players on p_table, oldest first, so the NEWEST arrival is the
-- last element. A departed row already holding a seat number is skipped (the
-- (table_id, seat_number) key is not partial).
CREATE FUNCTION pg_temp.fill(p_table uuid, p_n integer) RETURNS uuid[] LANGUAGE plpgsql AS $$
DECLARE i integer; seat integer := 0; out uuid[] := '{}';
BEGIN
  FOR i IN 1..p_n LOOP
    seat := seat + 1;
    WHILE EXISTS (SELECT 1 FROM public.table_seats x WHERE x.table_id = p_table AND x.seat_number = seat) LOOP
      seat := seat + 1;
    END LOOP;
    out := out || pg_temp.seat_copy(p_table, seat, (p_n - i) * interval '1 minute');
  END LOOP;
  RETURN out;
END $$;

-- The game's pending moves with the roles of both ends.
CREATE FUNCTION pg_temp.pending(p_game uuid)
RETURNS TABLE(reason text, from_role text, to_role text, player_id uuid, from_table_id uuid, to_table_id uuid) LANGUAGE sql AS $$
  SELECT m.reason, f.role, t.role, m.player_id, m.from_table_id, m.to_table_id
    FROM public.cash_seat_moves m JOIN public.tables f ON f.id = m.from_table_id JOIN public.tables t ON t.id = m.to_table_id
   WHERE m.game_id = p_game AND m.state = 'pending'
$$;

-- ── preamble: not frozen, and which tick this is ───────────────────────────
DO $$
DECLARE v_md5 text; v_n integer;
BEGIN
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'the platform is frozen (maintenance break): the tick returns skipped=frozen, run after :00';
  END IF;
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'fn_cash_cluster_tick';
  SELECT count(*) INTO v_n FROM public.cash_games WHERE must_move AND enabled;
  RAISE NOTICE 'fn_cash_cluster_tick body md5 % ; % enabled must-move games ; % dormant on house boards',
    v_md5, v_n, (SELECT count(*) FROM public.cash_games g WHERE g.must_move AND g.enabled AND g.state = 'dormant'
                   AND public.fn_ca_house_board_allows_automation(g.club_id));
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 1: Main 1 exactly full + an empty live feeder: the feeder does NOT arm (strict fit, 20260905040500)'
BEGIN;
DO $$
DECLARE g uuid; m1 uuid; f uuid; cap integer; i integer; t record;
BEGIN
  g := pg_temp.pick_dormant_game(); IF g IS NULL THEN RAISE EXCEPTION 'no dormant game to build on'; END IF;
  m1 := pg_temp.main1(g);
  SELECT coalesce(max_players, 9) INTO cap FROM public.tables WHERE id = m1;
  FOR i IN 1..cap LOOP PERFORM pg_temp.seat_copy(m1, i, (cap - i) * interval '1 minute'); END LOOP;
  f := public.fn_cash_cluster_open_table(g, 'feeder', NULL, 'live', NULL);
  RAISE NOTICE '      game % : Main 1 % seated %/% ; empty live feeder %', g, m1, cap, cap, f;
  PERFORM pg_temp.tick(g, 0);
  SELECT * INTO t FROM public.tables WHERE id = f;
  PERFORM pg_temp.ok(t.break_eligible_since IS NULL, 'a full Main 1 (seated_total = capacity) does not arm the empty feeder');
  PERFORM pg_temp.ok(t.lifecycle = 'live', 'the feeder is still live');
  PERFORM pg_temp.ok(pg_temp.events(g, 'table_break_started') = 0, 'no table_break_started');
  PERFORM pg_temp.ok(pg_temp.events(g, 'feeder_opened') = 1 AND pg_temp.events(g, 'main_opened') = 0, 'the tick opened nothing (one feeder_opened is ours)');
  -- Contrast: one open seat on Main 1 and the same board arms.
  UPDATE public.tables SET max_players = cap + 1 WHERE id = m1;
  PERFORM pg_temp.tick(g, 0);
  SELECT * INTO t FROM public.tables WHERE id = f;
  PERFORM pg_temp.ok(t.break_eligible_since IS NOT NULL, 'with one seat kept open on Main 1 (seated_total < capacity) the empty feeder arms');
END $$;
ROLLBACK;
\echo '     rolled back'

-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 2: a live seat''s parent CANNOT close - the shape this board used to repair is now impossible to build'
-- REWRITTEN 2026-09-09 (lane A of the must-move audit). This board used to
-- assert `closed_table_reopened_to_break`: the tick found a live seat on a
-- lifecycle-closed table and put the table back to `breaking` so the player
-- could be planned off it. That repair is GONE from the live function, and
-- correctly so - `20260909062236_terminal_tables_cannot_commit_live_occupancies`
-- (on production as version 20260909172529) made the shape unbuildable and
-- deleted the repair in the same migration, leaving the comment
--     -- Active seats cannot commit against a closed parent; no reopen repair is needed.
-- The board asserting the old event could never pass again, so it asserts the
-- new guarantee instead: the CLOSE is refused, at the schema, by
-- `live_seat_parent_cannot_close` FK (table_id, active_parent_key) ->
-- tables(id, seat_admission_key). A guard is better than a repair (CLAUDE.md
-- 10.11), and this pins that the repair may not come back while the guard
-- stands.
BEGIN;
DO $$
DECLARE g uuid; f uuid; p uuid; t record; v_err text; refused boolean := false; v_def text;
BEGIN
  g := pg_temp.pick_dormant_game(); IF g IS NULL THEN RAISE EXCEPTION 'no dormant game to build on'; END IF;
  f := public.fn_cash_cluster_open_table(g, 'feeder', NULL, 'live', NULL);
  p := pg_temp.seat_copy(f, 1, interval '5 minutes');
  RAISE NOTICE '      game % : feeder % with player % on it', g, f, p;

  BEGIN
    UPDATE public.tables SET lifecycle = 'closed' WHERE id = f;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    refused := true;
    RAISE NOTICE '      close refused: %', left(v_err, 120);
  END;
  PERFORM pg_temp.ok(refused, 'a table holding a live seat cannot be walked to lifecycle=closed');

  SELECT * INTO t FROM public.tables WHERE id = f;
  PERFORM pg_temp.ok(t.lifecycle <> 'closed', format('the table is still open (lifecycle=%s)', t.lifecycle));
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = f AND ts.left_at IS NULL),
                     'and the player still holds the chair - nobody was stranded to be repaired later');

  v_def := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);
  PERFORM pg_temp.ok(position('closed_table_reopened_to_break' in v_def) = 0,
                     'the retired reopen-to-break repair has not come back');
END $$;
ROLLBACK;
\echo '     rolled back'

-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 3: the ORBIT arm: s seated, eligible 90 s ago; 2s-1 hands stays eligible, 2s hands breaks (20260905083756)'
BEGIN;
DO $$
DECLARE g uuid; m1 uuid; f uuid; s integer := 2; t record; ev record; since timestamptz := clock_timestamp() - interval '90 seconds';
BEGIN
  g := pg_temp.pick_dormant_game(); IF g IS NULL THEN RAISE EXCEPTION 'no dormant game to build on'; END IF;
  m1 := pg_temp.main1(g);
  PERFORM pg_temp.seat_copy(m1, 1, interval '10 minutes');
  f := public.fn_cash_cluster_open_table(g, 'feeder', NULL, 'live', NULL);
  PERFORM pg_temp.seat_copy(f, 1, interval '6 minutes');
  PERFORM pg_temp.seat_copy(f, 2, interval '5 minutes');
  UPDATE public.tables SET break_eligible_since = since WHERE id = f;
  PERFORM pg_temp.hands(f, 2 * s - 1, since);
  RAISE NOTICE '      game % : feeder % seated %, eligible 90 s ago, % hands since', g, f, s, 2 * s - 1;
  PERFORM pg_temp.tick(g, 0);
  SELECT * INTO t FROM public.tables WHERE id = f;
  PERFORM pg_temp.ok(t.lifecycle = 'live' AND t.break_eligible_since = since, format('%s hands (2s-1) in 90 s: still live, still eligible since the same instant', 2 * s - 1));
  PERFORM pg_temp.ok(pg_temp.events(g, 'table_break_started') = 0, 'no table_break_started yet');
  PERFORM pg_temp.hands(f, 1, since + interval '30 seconds');
  PERFORM pg_temp.tick(g, 0);
  SELECT * INTO t FROM public.tables WHERE id = f;
  SELECT * INTO ev FROM public.cash_cluster_events WHERE game_id = g AND kind = 'table_break_started' AND table_id = f AND at >= now();
  PERFORM pg_temp.ok(t.lifecycle = 'breaking', format('%s hands (2s) in 90 s: breaking', 2 * s));
  PERFORM pg_temp.ok(ev.id IS NOT NULL AND (ev.payload->>'hands_since_eligible')::integer = 2 * s AND (ev.payload->>'orbit')::integer = s,
                     format('table_break_started payload hands_since_eligible=%s orbit=%s', ev.payload->>'hands_since_eligible', ev.payload->>'orbit'));
  PERFORM pg_temp.ok((clock_timestamp() - (ev.payload->>'eligible_since')::timestamptz) < interval '5 minutes', 'and it waited less than the five-minute clock');
END $$;
ROLLBACK;
\echo '     rolled back'

-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 4: the CLOCK arm: eligible 6 minutes ago, fewer hands than an orbit pair: breaks'
BEGIN;
DO $$
DECLARE g uuid; m1 uuid; f uuid; t record; ev record; since timestamptz := clock_timestamp() - interval '6 minutes';
BEGIN
  g := pg_temp.pick_dormant_game(); IF g IS NULL THEN RAISE EXCEPTION 'no dormant game to build on'; END IF;
  m1 := pg_temp.main1(g);
  PERFORM pg_temp.seat_copy(m1, 1, interval '10 minutes');
  f := public.fn_cash_cluster_open_table(g, 'feeder', NULL, 'live', NULL);
  PERFORM pg_temp.seat_copy(f, 1, interval '8 minutes');
  PERFORM pg_temp.seat_copy(f, 2, interval '7 minutes');
  UPDATE public.tables SET break_eligible_since = since WHERE id = f;
  PERFORM pg_temp.hands(f, 3, since);
  RAISE NOTICE '      game % : feeder % seated 2, eligible 6 min ago, 3 hands since', g, f;
  PERFORM pg_temp.tick(g, 0);
  SELECT * INTO t FROM public.tables WHERE id = f;
  SELECT * INTO ev FROM public.cash_cluster_events WHERE game_id = g AND kind = 'table_break_started' AND table_id = f AND at >= now();
  PERFORM pg_temp.ok(t.lifecycle = 'breaking', 'breaking on the clock arm');
  PERFORM pg_temp.ok(ev.id IS NOT NULL AND (ev.payload->>'hands_since_eligible')::integer = 3 AND (ev.payload->>'orbit')::integer = 2,
                     format('payload hands_since_eligible=%s orbit=%s (3 < 4, so it was the clock)', ev.payload->>'hands_since_eligible', ev.payload->>'orbit'));
END $$;
ROLLBACK;
\echo '     rolled back'

-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 5: the EMPTY table arms first and closes in 60 s (20260905194840)'
BEGIN;
DO $$
DECLARE g uuid; m1 uuid; m2 uuid; f uuid; tf record; tm record;
BEGIN
  g := pg_temp.pick_dormant_game(); IF g IS NULL THEN RAISE EXCEPTION 'no dormant game to build on'; END IF;
  m1 := pg_temp.main1(g);
  PERFORM pg_temp.seat_copy(m1, 1, interval '10 minutes');
  m2 := public.fn_cash_cluster_open_table(g, 'main', 2, 'live', NULL);
  PERFORM pg_temp.seat_copy(m2, 1, interval '5 minutes');
  f := public.fn_cash_cluster_open_table(g, 'feeder', NULL, 'live', NULL);
  RAISE NOTICE '      game % : Main 1 % (1 seated), Main 2 % (1 seated), feeder % (empty)', g, m1, m2, f;
  PERFORM pg_temp.tick(g, 0);
  SELECT * INTO tf FROM public.tables WHERE id = f;
  SELECT * INTO tm FROM public.tables WHERE id = m2;
  PERFORM pg_temp.ok(tf.break_eligible_since IS NOT NULL, 'first tick arms the EMPTY table');
  PERFORM pg_temp.ok(tm.break_eligible_since IS NULL, 'and not the 1-seat table');
  UPDATE public.tables SET break_eligible_since = clock_timestamp() - interval '61 seconds' WHERE id = f;
  PERFORM pg_temp.tick(g, 0);
  SELECT * INTO tf FROM public.tables WHERE id = f;
  PERFORM pg_temp.ok(tf.lifecycle = 'closed' AND tf.status = 'closed', 'after 61 s the empty table is closed in the same tick it breaks');
  PERFORM pg_temp.ok(pg_temp.events(g, 'table_break_started', f) = 1 AND pg_temp.events(g, 'table_break_completed', f) = 1, 'events table_break_started + table_break_completed');
  SELECT * INTO tm FROM public.tables WHERE id = m2;
  PERFORM pg_temp.ok(tm.lifecycle = 'live', 'the 1-seat table is still live');
END $$;
ROLLBACK;
\echo '     rolled back'

-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 6: a lone live feeder with no live Main: promoted to Main 1 (feeder_promoted_to_main, reason no_live_main)'
BEGIN;
DO $$
DECLARE g uuid; m1 uuid; f uuid; t record; ev record;
BEGIN
  g := pg_temp.pick_dormant_game(); IF g IS NULL THEN RAISE EXCEPTION 'no dormant game to build on'; END IF;
  m1 := pg_temp.main1(g);
  f := public.fn_cash_cluster_open_table(g, 'feeder', NULL, 'live', NULL);
  PERFORM pg_temp.seat_copy(f, 1, interval '6 minutes');
  PERFORM pg_temp.seat_copy(f, 2, interval '5 minutes');
  UPDATE public.tables SET status = 'closed', lifecycle = 'closed' WHERE id = m1;   -- empty, so the close guard allows it
  RAISE NOTICE '      game % : Main 1 % closed, feeder % live with 2 seated', g, m1, f;
  PERFORM pg_temp.tick(g, 0);
  SELECT * INTO t FROM public.tables WHERE id = f;
  SELECT * INTO ev FROM public.cash_cluster_events WHERE game_id = g AND kind = 'feeder_promoted_to_main' AND table_id = f AND at >= now();
  PERFORM pg_temp.ok(t.role = 'main' AND t.main_index = 1 AND t.lifecycle = 'live', 'the feeder is main/1 live');
  PERFORM pg_temp.ok(ev.id IS NOT NULL AND ev.payload->>'reason' = 'no_live_main', 'event feeder_promoted_to_main {reason: no_live_main}');
  PERFORM pg_temp.ok(pg_temp.events(g, 'main_opened') = 0, 'R3 opened no second Main 1 beside it');
END $$;
ROLLBACK;
\echo '     rolled back'

-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 7: R3 does not loop (20260905194329): a closed Main 1 next to a live table opens nothing; no live table at all opens exactly one, once'
BEGIN;
DO $$
DECLARE g uuid; m1 uuid; f uuid; n integer; g2 uuid; m1b uuid; t record;
BEGIN
  -- (a) the only Main 1 row is closed, another live table exists
  g := pg_temp.pick_dormant_game(); IF g IS NULL THEN RAISE EXCEPTION 'no dormant game to build on'; END IF;
  m1 := pg_temp.main1(g);
  f := public.fn_cash_cluster_open_table(g, 'feeder', NULL, 'live', NULL);
  UPDATE public.tables SET status = 'closed', lifecycle = 'closed' WHERE id = m1;
  RAISE NOTICE '      (a) game % : Main 1 % closed, feeder % live and empty', g, m1, f;
  PERFORM pg_temp.tick(g, 0);
  PERFORM pg_temp.tick(g, 0);
  SELECT count(*) INTO n FROM public.tables WHERE cluster_id = g AND lifecycle <> 'closed' AND coalesce(is_deleted, false) = false;
  PERFORM pg_temp.ok(pg_temp.events(g, 'main_opened') = 0, '(a) two ticks: main_opened = 0');
  PERFORM pg_temp.ok(n = 1, format('(a) the game still has exactly one open table (%s)', n));
  -- (b) no live table at all
  UPDATE public.tables SET status = 'closed', lifecycle = 'closed' WHERE cluster_id = g AND lifecycle <> 'closed';
  RAISE NOTICE '      (b) game % : every table closed', g;
  PERFORM pg_temp.tick(g, 0);
  SELECT count(*) INTO n FROM public.tables WHERE cluster_id = g AND lifecycle <> 'closed' AND coalesce(is_deleted, false) = false;
  PERFORM pg_temp.ok(pg_temp.events(g, 'main_opened') = 1 AND n = 1, '(b) first tick: exactly one Main 1 opened');
  SELECT * INTO t FROM public.tables WHERE id = pg_temp.main1(g);
  PERFORM pg_temp.ok(t.id IS NOT NULL AND t.lifecycle = 'live' AND t.status = 'waiting', '(b) it is main/1, live, waiting');
  PERFORM pg_temp.tick(g, 0);
  PERFORM pg_temp.tick(g, 0);
  SELECT count(*) INTO n FROM public.tables WHERE cluster_id = g AND lifecycle <> 'closed' AND coalesce(is_deleted, false) = false;
  PERFORM pg_temp.ok(pg_temp.events(g, 'main_opened') = 1 AND n = 1, '(b) two more ticks: still one main_opened, still one open table');
END $$;
ROLLBACK;
\echo '     rolled back'

-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 8: ONE committed chair per player per game - the door refuses it, and so does the schema, even for the executor'
-- REWRITTEN 2026-09-09 (lane A of the must-move audit). This board used to
-- force a second chair past the trigger door with the executor's own GUC and
-- then assert that the TICK cleaned it up - `second_chair_leave_pending` on a
-- running table, `second_chair_cashed_out` on a waiting one. Both of those
-- reconcile branches are GONE from the live function, replaced by
--     -- Duplicate committed chairs are rejected by one_committed_seat_per_game_player.
-- (`..._retire_cluster_duplicate_chair_cashouts_after_native_ownership`, on
-- production as version 20260909172447). A cleanup that runs after the fact
-- was replaced by a constraint that makes the state unreachable, which is the
-- right direction (CLAUDE.md 10.12), and this board now pins THAT.
--
-- `one_committed_seat_per_game_player` is UNIQUE (user_id, active_game_scope)
-- DEFERRABLE INITIALLY DEFERRED, and `fn_stamp_table_game_scope` stamps every
-- cluster table `cluster:<cash_games.id>` - so two live chairs anywhere in one
-- must-move game collide on it. Deferred means the violation surfaces at
-- COMMIT; the board makes it IMMEDIATE so a rolled-back probe can see it.
BEGIN;
DO $$
DECLARE g uuid; a record; b record; seat_b integer; v_err text;
        door_refused boolean := false; schema_refused boolean := false; v_def text;
BEGIN
  SELECT ts.user_id, ts.table_id, ts.stack, ts.club_id, tb.cluster_id AS game_id, ts.joined_at
    INTO a
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id JOIN public.cash_games cg ON cg.id = tb.cluster_id
   WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL AND coalesce(ts.stack, 0) > 0 AND coalesce(ts.leave_pending, false) = false
     AND tb.lifecycle = 'live' AND cg.must_move AND cg.enabled
     AND (SELECT count(*) FROM public.table_seats o WHERE o.user_id = ts.user_id AND o.left_at IS NULL) = 1
     AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'pending')
     AND EXISTS (SELECT 1 FROM public.tables o WHERE o.cluster_id = tb.cluster_id AND o.id <> tb.id AND o.lifecycle = 'live'
                    AND o.status IN ('waiting', 'running') AND coalesce(o.is_deleted, false) = false
                    AND (SELECT count(*) FROM public.table_seats x WHERE x.table_id = o.id) < coalesce(o.max_players, 9))
   ORDER BY ts.joined_at LIMIT 1;
  IF a.user_id IS NULL THEN RAISE EXCEPTION 'no live game with a second table that has room'; END IF;
  g := a.game_id;
  SELECT o.* INTO b FROM public.tables o
   WHERE o.cluster_id = g AND o.id <> a.table_id AND o.lifecycle = 'live' AND o.status IN ('waiting', 'running') AND coalesce(o.is_deleted, false) = false
     AND (SELECT count(*) FROM public.table_seats x WHERE x.table_id = o.id) < coalesce(o.max_players, 9)
   ORDER BY o.created_at LIMIT 1;
  SELECT min(n) INTO seat_b FROM generate_series(1, coalesce(b.max_players, 9)) n
   WHERE NOT EXISTS (SELECT 1 FROM public.table_seats x WHERE x.table_id = b.id AND x.seat_number = n);
  RAISE NOTICE '      game % : player % seated on % ; second table % (%) seat %', g, a.user_id, a.table_id, b.id, b.status, seat_b;

  -- 1. the door (fn_refuse_seat_on_closed_cluster_table)
  BEGIN
    INSERT INTO public.table_seats (table_id, seat_number, user_id, stack, status, joined_at)
    VALUES (b.id, seat_b, a.user_id, a.stack, 'active', clock_timestamp());
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    door_refused := v_err LIKE 'ALREADY_IN_GAME%';
    RAISE NOTICE '      door: %', left(v_err, 100);
  END;
  PERFORM pg_temp.ok(door_refused, 'the door refuses a second chair in the same game (ALREADY_IN_GAME)');

  -- 2. past the door, with the executor's own flag: the SCHEMA refuses it too.
  --    This is the case the retired reconcile branches existed to clean up.
  BEGIN
    SET CONSTRAINTS public.one_committed_seat_per_game_player IMMEDIATE;
    PERFORM set_config('app.cash_seat_move', 'on', true);
    INSERT INTO public.table_seats (table_id, seat_number, user_id, stack, status, joined_at)
    VALUES (b.id, seat_b, a.user_id, a.stack, 'active', clock_timestamp());
    PERFORM set_config('app.cash_seat_move', '', true);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    PERFORM set_config('app.cash_seat_move', '', true);
    schema_refused := v_err LIKE '%one_committed_seat_per_game_player%';
    RAISE NOTICE '      schema: %', left(v_err, 140);
  END;
  PERFORM pg_temp.ok(schema_refused,
                     'one_committed_seat_per_game_player refuses the second chair even with the executor flag set');

  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM public.table_seats ts
                              WHERE ts.table_id = a.table_id AND ts.user_id = a.user_id AND ts.left_at IS NULL),
                     'the older chair is still theirs, and no chip moved');

  v_def := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);
  PERFORM pg_temp.ok(position('second_chair_cashed_out' in v_def) = 0
                 AND position('second_chair_leave_pending' in v_def) = 0,
                     'the retired duplicate-chair cleanup has not come back');
END $$;
ROLLBACK;
\echo '     rolled back'

-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 9: a disabled game closes its empty tables (table_closed_disabled) and opens nothing'
BEGIN;
DO $$
DECLARE g uuid; m1 uuid; f uuid; t record; n integer;
BEGIN
  g := pg_temp.pick_dormant_game(); IF g IS NULL THEN RAISE EXCEPTION 'no dormant game to build on'; END IF;
  m1 := pg_temp.main1(g);
  f := public.fn_cash_cluster_open_table(g, 'feeder', NULL, 'live', NULL);
  UPDATE public.cash_games SET enabled = false WHERE id = g;
  RAISE NOTICE '      game % disabled : Main 1 % empty, feeder % empty', g, m1, f;
  PERFORM pg_temp.tick(g, 9);   -- nine eligible horses: still nothing opens
  SELECT * INTO t FROM public.tables WHERE id = f;
  PERFORM pg_temp.ok(t.lifecycle = 'closed' AND t.status = 'closed', 'the empty feeder is closed');
  PERFORM pg_temp.ok(pg_temp.events(g, 'table_closed_disabled', f) = 1, 'event table_closed_disabled for it');
  SELECT count(*) INTO n FROM public.tables WHERE cluster_id = g AND lifecycle <> 'closed' AND coalesce(is_deleted, false) = false;
  PERFORM pg_temp.ok(n = 0, 'every empty table of the disabled game is closed');
  PERFORM pg_temp.ok(pg_temp.events(g, 'main_opened') = 0 AND pg_temp.events(g, 'feeder_opened') = 1, 'nothing was opened (the one feeder_opened is ours)');
END $$;
ROLLBACK;
\echo '     rolled back'

-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 10: current_players follows the seats (20260905202112)'
BEGIN;
DO $$
DECLARE t record; g uuid; n integer;
BEGIN
  SELECT tb.* INTO t FROM public.tables tb JOIN public.cash_games cg ON cg.id = tb.cluster_id
   WHERE tb.lifecycle <> 'closed' AND coalesce(tb.is_deleted, false) = false AND cg.must_move AND cg.enabled
     AND EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL)
   ORDER BY (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL) DESC, tb.created_at LIMIT 1;
  IF t.id IS NULL THEN RAISE EXCEPTION 'no seated live cluster table'; END IF;
  g := t.cluster_id;
  SELECT count(*) INTO n FROM public.table_seats WHERE table_id = t.id AND left_at IS NULL;
  UPDATE public.tables SET current_players = 99 WHERE id = t.id;
  RAISE NOTICE '      game % : table % has % seats, current_players set to 99', g, t.id, n;
  PERFORM pg_temp.tick(g, 0);
  SELECT * INTO t FROM public.tables WHERE id = t.id;
  PERFORM pg_temp.ok(t.current_players = n, format('after the tick current_players = %s = the live seat count', t.current_players));
  UPDATE public.tables SET current_players = 0 WHERE id = t.id;
  PERFORM pg_temp.tick(g, 0);
  SELECT * INTO t FROM public.tables WHERE id = t.id;
  PERFORM pg_temp.ok(t.current_players = n, 'and from 0 (the 22-tables-live shape) it is corrected the same way');
END $$;
ROLLBACK;
\echo '     rolled back'

-- ═══════════════════════════════════════════════════════════════════════════
-- BOARDS 11-14 were added on 2026-09-09 by lane A of the must-move audit, one
-- per migration in that lane. THEY REQUIRE THOSE MIGRATIONS TO BE APPLIED:
--   20260909181632  a_move_cannot_be_late_while_the_platform_is_parking
--   20260909181642  every_expiry_says_why_including_the_executors
--   20260909181653  the_worklist_admits_a_game_with_a_half_closed_table
--   20260909181704  a_main_keeps_its_number_while_it_breaks
-- Until the integrator applies them these four fail, and that failure is the
-- correct reading: the behaviour they pin is not on the database yet.
-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 11: no expiry path in the tick OR either executor writes a state without a reason (20260909181642)'
BEGIN;
DO $$
DECLARE v_move text; v_swap text; v_tick text;
BEGIN
  v_move := pg_get_functiondef('public.fn_cash_seat_move_execute_before_maintenance_gate'::regproc);
  v_swap := pg_get_functiondef('public.fn_cash_seat_swap_execute_before_maintenance_gate'::regproc);
  v_tick := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);
  PERFORM pg_temp.ok(position('expired_before_the_executor_reached_it' in v_move) > 0,
                     'the move executor names its own late arrival');
  PERFORM pg_temp.ok(position('own_ttl_expired' in v_swap) > 0 AND position('swap_partner_expired' in v_swap) > 0,
                     'the swap executor tells its own timeout from its partner''s, and does not mark a live partner expired');
  PERFORM pg_temp.ok(position($q$SET state = 'expired' WHERE$q$ in v_move) = 0
                 AND position($q$SET state = 'expired' WHERE$q$ in v_swap) = 0
                 AND position($q$SET state = 'expired' WHERE$q$ in v_tick) = 0,
                     'nowhere in the move lifecycle is `expired` written without a note');
END $$;
ROLLBACK;
\echo '     rolled back'

-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 12: a game whose only table is half-closed is ticked, and one tick makes the two fields agree (20260909181653)'
BEGIN;
DO $$
DECLARE t record; g uuid; n integer; before_n integer; r jsonb;
BEGIN
  SELECT tb.* INTO t FROM public.tables tb JOIN public.cash_games cg ON cg.id = tb.cluster_id
   WHERE cg.must_move AND coalesce(tb.is_deleted, false) = false
     AND tb.lifecycle = 'closed'
     AND lower(coalesce(tb.status, '')) NOT IN ('closed','completed','cancelled','finished')
     AND NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL)
   ORDER BY tb.updated_at LIMIT 1;
  IF t.id IS NULL THEN
    -- Nothing is stranded right now, which is the outcome this fix produces.
    -- Build the shape rather than skipping: the point is that the worklist
    -- reaches it.
    SELECT tb.* INTO t FROM public.tables tb JOIN public.cash_games cg ON cg.id = tb.cluster_id
     WHERE cg.must_move AND NOT cg.enabled AND coalesce(tb.is_deleted, false) = false
       AND tb.lifecycle = 'closed' AND lower(coalesce(tb.status,'')) = 'closed'
       AND NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL)
     ORDER BY tb.updated_at DESC LIMIT 1;
    IF t.id IS NULL THEN RAISE NOTICE 'SKIP  no disabled game with a closed table to build the shape on'; RETURN; END IF;
    UPDATE public.tables SET status = 'waiting' WHERE id = t.id;
    SELECT * INTO t FROM public.tables WHERE id = t.id;
  END IF;
  g := t.cluster_id;
  RAISE NOTICE '      table % (%): status=% lifecycle=%', t.id, t.name, t.status, t.lifecycle;

  SELECT count(*) INTO n FROM public.fn_cash_clusters_to_tick() l WHERE l.game_id = g;
  PERFORM pg_temp.ok(n = 1, 'its game is on the worklist, so the repair inside the tick can reach it');

  SELECT count(*) INTO before_n FROM public.cash_cluster_events
   WHERE game_id = g AND kind = 'status_followed_lifecycle' AND at >= now();
  r := pg_temp.tick(g, 0);
  SELECT * INTO t FROM public.tables WHERE id = t.id;
  PERFORM pg_temp.ok(lower(t.status) = 'closed' AND t.lifecycle = 'closed',
                     format('one tick made the two fields agree (status=%s lifecycle=%s)', t.status, t.lifecycle));
  SELECT count(*) INTO n FROM public.cash_cluster_events
   WHERE game_id = g AND kind = 'status_followed_lifecycle' AND at >= now();
  PERFORM pg_temp.ok(n > before_n, 'and said so with status_followed_lifecycle');
  SELECT count(*) INTO n FROM public.fn_cash_clusters_to_tick() l WHERE l.game_id = g;
  PERFORM pg_temp.ok(n = 0, 'the game then leaves the worklist: admitted once, not for ever');
END $$;
ROLLBACK;
\echo '     rolled back'

-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 13: a breaking Main does not keep a number a survivor is renumbered into (20260909181704)'
BEGIN;
DO $$
DECLARE g uuid; m1 uuid; m2 uuid; m3 uuid; fd uuid; p uuid; r jsonb;
        v_m2 record; v_m3 record; v_dupes integer;
BEGIN
  g := pg_temp.pick_dormant_game(); IF g IS NULL THEN RAISE EXCEPTION 'no dormant game to build on'; END IF;
  m1 := pg_temp.main1(g);
  m2 := public.fn_cash_cluster_open_table(g, 'main', 2, 'live', NULL);
  m3 := public.fn_cash_cluster_open_table(g, 'main', 3, 'live', NULL);
  -- a live feeder, so the demote-to-feeder step does not take Main 3 instead
  fd := public.fn_cash_cluster_open_table(g, 'feeder', NULL, 'live', NULL);
  -- Main 2 breaks holding one player: an EMPTY breaking table is closed by
  -- step 5 before the roles step is ever reached.
  p := pg_temp.seat_copy(m2, 1);
  UPDATE public.tables SET lifecycle = 'breaking', break_started_at = clock_timestamp() WHERE id = m2;
  RAISE NOTICE '      game % : main1 % main2 %(breaking, 1 seat) main3 % feeder %', g, m1, m2, m3, fd;

  r := pg_temp.tick(g, 0);
  SELECT id, name, role, main_index, lifecycle INTO v_m2 FROM public.tables WHERE id = m2;
  SELECT id, name, role, main_index, lifecycle INTO v_m3 FROM public.tables WHERE id = m3;
  RAISE NOTICE '      after: breaking main_index=% name=% ; survivor main_index=% name=%',
    v_m2.main_index, v_m2.name, v_m3.main_index, v_m3.name;

  PERFORM pg_temp.ok(v_m3.main_index = 2,
                     'the survivor is renumbered into the breaking table''s old index (the collision is reachable)');
  PERFORM pg_temp.ok(v_m2.main_index > v_m3.main_index,
                     format('and the breaking table was moved above the live range (%s)', v_m2.main_index));
  PERFORM pg_temp.ok(v_m2.lifecycle = 'breaking', 'its lifecycle is untouched');
  SELECT count(*) INTO v_dupes FROM (
    SELECT main_index FROM public.tables
     WHERE cluster_id = g AND role = 'main' AND main_index IS NOT NULL
       AND lifecycle <> 'closed' AND coalesce(is_deleted, false) = false
     GROUP BY 1 HAVING count(*) > 1) d;
  PERFORM pg_temp.ok(v_dupes = 0, 'no two open tables of the game share a main_index');
  PERFORM pg_temp.ok(r->'actions' @> jsonb_build_array(jsonb_build_object('breaking_main_renumbered', m2)),
                     format('the tick says so: %s', r->'actions'));
END $$;
ROLLBACK;
\echo '     rolled back'

-- ═══════════════════════════════════════════════════════════════════════════
-- BOARDS 15-18 were added on 2026-09-10 (lane A follow-up). THEY REQUIRE
--   20260910181433  the_balancer_balances_feeders_and_leaves_the_mains_to_must_move
--   20260910181447  a_refusal_gets_its_minute_from_the_moment_it_was_refused
--   20260909181642  every_expiry_says_why_including_the_executors (with the F4 fold)
-- Board 14 stays LAST in the file: it holds the maintenance advisory lock.
-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 15: the round trip is gone - the balancer leaves a full main alone, and the tick has nothing to reverse (J-1, 20260910181433)'
BEGIN;
DO $$
DECLARE g uuid; m1 uuid; m2 uuid; f uuid; n integer; r jsonb; c integer;
BEGIN
  g := pg_temp.pick_dormant_game(); IF g IS NULL THEN RAISE EXCEPTION 'no dormant game to build on'; END IF;
  m1 := pg_temp.main1(g);
  UPDATE public.tables SET max_players = 2 WHERE id = m1;  PERFORM pg_temp.fill(m1, 2);   -- Main 1 full
  m2 := public.fn_cash_cluster_open_table(g, 'main', 2, 'live', NULL);
  UPDATE public.tables SET max_players = 3 WHERE id = m2;  PERFORM pg_temp.fill(m2, 3);   -- Main 2 full
  f := public.fn_cash_cluster_open_table(g, 'feeder', NULL, 'live', NULL);
  PERFORM pg_temp.fill(f, 1);                                                             -- feeder at 1
  RAISE NOTICE '      game % : Main 1 %/2 full, Main 2 %/3 full, feeder 1 (%)', g, m1, m2, f;

  -- The 20260906011318 pool was "everything but Main 1": Main 2 (3) vs the
  -- feeder (1) satisfied hi - lo >= 2, hi >= 3, lo >= 1 and the newest
  -- arrival on Main 2 was sent to the feeder - then step 2 sent the
  -- longest-seated feeder player straight back. 355 exact round trips in
  -- one hour on production (lane J section 6).
  n := public.fn_cash_cluster_balance(g, clock_timestamp());
  PERFORM pg_temp.ok(n = 0, format('the balancer plans %s moves on Main 1 full / Main 2 full / feeder at 1', n));
  r := pg_temp.tick(g, 0);
  n := public.fn_cash_cluster_balance(g, clock_timestamp());
  SELECT count(*) INTO c FROM pg_temp.pending(g);
  PERFORM pg_temp.ok(c = 0 AND n = 0, format('a full tick + balance pass plans nothing (pending=%s, balanced=%s): no leg to reverse, no round trip', c, n));
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_temp.pending(g) p WHERE p.from_role = 'main' AND p.to_role = 'feeder'),
                     'no move takes a player off a main onto the feeder');
  -- a main with an OPEN seat still gets nobody from the balancer: that seat is step 2's
  UPDATE public.tables SET max_players = 4 WHERE id = m2;
  n := public.fn_cash_cluster_balance(g, clock_timestamp());
  PERFORM pg_temp.ok(n = 0, 'a main with an open seat receives no balance move');
  r := pg_temp.tick(g, 0);
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM pg_temp.pending(g) p WHERE p.reason = 'must_move' AND p.to_table_id = m2 AND p.from_table_id = f),
                     'and step 2 fills it from the feeder, in must-move order, as the rule says');
END $$;
ROLLBACK;
\echo '     rolled back'

-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 16: two feeders still balance to within one player of each other (20260910181433)'
BEGIN;
DO $$
DECLARE g uuid; m1 uuid; fa uuid; fb uuid; players uuid[]; n integer; r record; t jsonb;
BEGIN
  g := pg_temp.pick_dormant_game(); IF g IS NULL THEN RAISE EXCEPTION 'no dormant game to build on'; END IF;
  m1 := pg_temp.main1(g);
  UPDATE public.tables SET max_players = 2 WHERE id = m1;  PERFORM pg_temp.fill(m1, 2);   -- Main 1 full: step 2 idle
  fa := public.fn_cash_cluster_open_table(g, 'feeder', NULL, 'live', NULL);
  fb := public.fn_cash_cluster_open_table(g, 'feeder', NULL, 'live', NULL);
  players := pg_temp.fill(fa, 3);                                                         -- feeder A at 3
  PERFORM pg_temp.fill(fb, 1);                                                            -- feeder B at 1
  RAISE NOTICE '      game % : Main 1 full, feeder A % at 3, feeder B % at 1', g, fa, fb;
  n := public.fn_cash_cluster_balance(g, clock_timestamp());
  SELECT * INTO r FROM pg_temp.pending(g) LIMIT 1;
  PERFORM pg_temp.ok(n = 1 AND r.reason = 'balance' AND r.from_table_id = fa AND r.to_table_id = fb,
                     format('feeder A (3) -> feeder B (1): %s balance move planned, feeder -> feeder', n));
  PERFORM pg_temp.ok(r.player_id = players[3], 'and it is the NEWEST arrival on feeder A who moves');
  t := pg_temp.tick(g, 0);
  PERFORM pg_temp.ok((SELECT count(*) FROM pg_temp.pending(g)) = 1
                 AND NOT EXISTS (SELECT 1 FROM pg_temp.pending(g) p WHERE p.reason = 'must_move'),
                     'the tick plans no must_move against it (Main 1 is full); the balance stands');
  n := public.fn_cash_cluster_balance(g, clock_timestamp());
  PERFORM pg_temp.ok(n = 0, 'a second pass plans nothing: A counts 2 outbound-adjusted, B counts 2 inbound-adjusted');
END $$;
ROLLBACK;
\echo '     rolled back'

-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 17: a refusal gets its minute from the moment it was refused (A7, 20260910181447)'
BEGIN;
DO $$
DECLARE g uuid; m1 uuid; fa uuid; fb uuid; mv record; mv2 record; n integer; who uuid;
BEGIN
  g := pg_temp.pick_dormant_game(); IF g IS NULL THEN RAISE EXCEPTION 'no dormant game to build on'; END IF;
  m1 := pg_temp.main1(g);
  UPDATE public.tables SET max_players = 2 WHERE id = m1;  PERFORM pg_temp.fill(m1, 2);
  fa := public.fn_cash_cluster_open_table(g, 'feeder', NULL, 'live', NULL);
  fb := public.fn_cash_cluster_open_table(g, 'feeder', NULL, 'live', NULL);
  PERFORM pg_temp.fill(fa, 3);  PERFORM pg_temp.fill(fb, 1);
  n := public.fn_cash_cluster_balance(g, clock_timestamp());
  SELECT m.* INTO mv FROM public.cash_seat_moves m WHERE m.game_id = g AND m.state = 'pending' AND m.reason = 'balance';
  PERFORM pg_temp.ok(n = 1 AND mv.resolved_at IS NULL, 'a pending move carries no resolved_at');
  -- the engine refuses it, the way an executor does
  UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_full' WHERE id = mv.id;
  SELECT m.* INTO mv FROM public.cash_seat_moves m WHERE m.id = mv.id;
  PERFORM pg_temp.ok(mv.resolved_at IS NOT NULL AND mv.resolved_at >= mv.created_at,
                     format('the refusal is stamped by the trigger: resolved_at=%s', mv.resolved_at));
  -- Planned ten minutes ago, refused just now. Under the old rule (created_at)
  -- the minute was long gone and THIS player - the newest arrival, the
  -- balancer's first choice - was re-planned at once.
  UPDATE public.cash_seat_moves SET created_at = clock_timestamp() - interval '10 minutes' WHERE id = mv.id;
  n := public.fn_cash_cluster_balance(g, clock_timestamp());
  SELECT p.player_id INTO who FROM pg_temp.pending(g) p;
  PERFORM pg_temp.ok(n = 1 AND who <> mv.player_id,
                     'planned 10 min ago, refused now: the refused player is backed off and the balancer takes the next newest');
  SELECT m.* INTO mv2 FROM public.cash_seat_moves m WHERE m.game_id = g AND m.state = 'pending';
  UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_full' WHERE id = mv2.id;
  UPDATE public.cash_seat_moves SET resolved_at = clock_timestamp() - interval '61 seconds' WHERE id = mv.id;
  n := public.fn_cash_cluster_balance(g, clock_timestamp());
  SELECT p.player_id INTO who FROM pg_temp.pending(g) p;
  PERFORM pg_temp.ok(n = 1 AND who = mv.player_id,
                     'refused 61 s ago: that player''s minute is served and they are planned again; the one refused just now is not');
  SELECT m.* INTO mv2 FROM public.cash_seat_moves m WHERE m.game_id = g AND m.state = 'pending';
  UPDATE public.cash_seat_moves SET state = 'done', executed_at = clock_timestamp() WHERE id = mv2.id;
  SELECT m.* INTO mv2 FROM public.cash_seat_moves m WHERE m.id = mv2.id;
  PERFORM pg_temp.ok(mv2.state = 'done' AND mv2.resolved_at IS NOT NULL AND mv2.executed_at IS NOT NULL,
                     'a landed move carries both executed_at and resolved_at');
END $$;
ROLLBACK;
\echo '     rolled back'

-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 18: the swap gate refuses a destination that does not exist (F4, folded into 20260909181642)'
BEGIN;
DO $$
DECLARE v_swap text;
BEGIN
  v_swap := pg_get_functiondef('public.fn_cash_seat_swap_execute_before_maintenance_gate'::regproc);
  PERFORM pg_temp.ok(position('ta.id IS NULL OR tb.id IS NULL' in v_swap) > 0
                 AND position($q$ta.status NOT IN ('waiting', 'running', 'active')$q$ in v_swap) > 0
                 AND position($q$tb.status NOT IN ('waiting', 'running', 'active')$q$ in v_swap) > 0,
                     'both destinations must exist and be open by lifecycle AND status');
  PERFORM pg_temp.ok(position($q$IF ta.lifecycle IN ('breaking', 'closed') OR tb.lifecycle IN ('breaking', 'closed') THEN$q$ in v_swap) = 0,
                     'the lifecycle-only test is gone');
END $$;
ROLLBACK;
\echo '     rolled back'

-- ═══════════════════════════════════════════════════════════════════════════
\echo
\echo '---- BOARD 14: a move planned before the park is HELD, not expired, and not blamed on the engine (20260909181632)'
-- THIS BOARD WRITES engine_maintenance_break, whose statement trigger takes
-- pg_advisory_xact_lock(530090, 1) EXCLUSIVE for the rest of the transaction -
-- and every live fn_cash_seat_move_execute takes the same key in SHARE mode.
-- It is therefore LAST in the file and its transaction is rolled back
-- immediately, so the lock is held for about a second. Do not move it earlier
-- and do not add statements after the ROLLBACK.
BEGIN;
DO $$
DECLARE g uuid; m1 uuid; f uuid; p uuid; mv public.cash_seat_moves%ROWTYPE; r jsonb; e0 timestamptz;
BEGIN
  g := pg_temp.pick_dormant_game(); IF g IS NULL THEN RAISE EXCEPTION 'no dormant game to build on'; END IF;
  m1 := pg_temp.main1(g);
  f := public.fn_cash_cluster_open_table(g, 'feeder', NULL, 'live', NULL);
  p := pg_temp.seat_copy(f, 1);
  RAISE NOTICE '      game % main1 % feeder % player %', g, m1, f, p;

  r := pg_temp.tick(g, 0);
  SELECT * INTO mv FROM public.cash_seat_moves WHERE game_id = g AND player_id = p AND state = 'pending';
  PERFORM pg_temp.ok(mv.id IS NOT NULL AND mv.to_table_id = m1 AND mv.reason = 'must_move',
                     format('the tick planned a must_move for the feeder player onto Main 1 (%s)', mv.id));

  -- The :52:30-to-:55:00 window: fn_entry_purchases_frozen() is true from
  -- announced_at - 30s, fn_platform_frozen() only from announced_at + 2min.
  UPDATE public.cash_seat_moves SET expires_at = clock_timestamp() - interval '1 second' WHERE id = mv.id;
  INSERT INTO public.engine_maintenance_break
    (id, phase, announced_at, break_started_at, break_ends_at, reason, declared_by, enforce_freeze, ownership_token)
  VALUES (true, 'last_hand', clock_timestamp(), NULL, NULL,
          'probe-cluster-boards (rolled back)', 'probe-cluster-boards', true, gen_random_uuid());
  PERFORM pg_temp.ok(public.fn_entry_purchases_frozen() AND NOT public.fn_platform_frozen(),
                     'the board is in the park window: entry purchases frozen, platform not yet frozen');
  PERFORM pg_temp.ok(public.fn_cash_seat_move_execute(mv.id) ->> 'reason' = 'platform_frozen',
                     'and the executor refuses this exact move with platform_frozen');

  SELECT expires_at INTO e0 FROM public.cash_seat_moves WHERE id = mv.id;
  r := pg_temp.tick(g, 0);
  SELECT * INTO mv FROM public.cash_seat_moves WHERE id = mv.id;
  PERFORM pg_temp.ok(mv.state = 'pending', format('the move is still pending, not expired (state=%s)', mv.state));
  PERFORM pg_temp.ok(mv.expires_at > clock_timestamp() AND mv.expires_at >= e0,
                     'its deadline was held forward past now, and never shortened');
  PERFORM pg_temp.ok(r->'actions' @> '[{"moves_held_for_maintenance": 1}]'::jsonb,
                     format('the tick says so: %s', r->'actions'));

  DELETE FROM public.engine_maintenance_break;
  UPDATE public.cash_seat_moves SET expires_at = clock_timestamp() - interval '1 second' WHERE id = mv.id;
  r := pg_temp.tick(g, 0);
  SELECT * INTO mv FROM public.cash_seat_moves WHERE id = mv.id;
  PERFORM pg_temp.ok(mv.state = 'expired' AND mv.note = 'engine_did_not_execute_before_expiry',
                     format('outside the park it expires exactly as before (state=%s note=%s)', mv.state, mv.note));
END $$;
ROLLBACK;
\echo '     rolled back'

\echo
\echo ================================================================
\echo  all eighteen boards passed; every transaction was rolled back
\echo ================================================================
