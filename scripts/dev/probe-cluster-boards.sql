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
\echo '---- BOARD 2: a live seat on a CLOSED table: the tick puts it back to breaking and plans the player out (closed_table_reopened_to_break)'
BEGIN;
DO $$
DECLARE g uuid; m1 uuid; f uuid; p uuid; t record; mv record;
BEGIN
  g := pg_temp.pick_dormant_game(); IF g IS NULL THEN RAISE EXCEPTION 'no dormant game to build on'; END IF;
  m1 := pg_temp.main1(g);
  PERFORM pg_temp.seat_copy(m1, 1, interval '10 minutes');
  f := public.fn_cash_cluster_open_table(g, 'feeder', NULL, 'live', NULL);
  p := pg_temp.seat_copy(f, 1, interval '5 minutes');
  -- The door refuses a seat on a closed table, and the status path refuses to
  -- close a seated table (fn_guard_managed_game_lifecycle) and would cash the
  -- seat out (trg_tables_auto_cashout_on_close). So the shape that reached
  -- production is built the only way it can be: lifecycle closed, status not.
  UPDATE public.tables SET lifecycle = 'closed' WHERE id = f;
  RAISE NOTICE '      game % : feeder % lifecycle=closed status=waiting with player % on it', g, f, p;
  PERFORM pg_temp.tick(g, 0);
  SELECT * INTO t FROM public.tables WHERE id = f;
  PERFORM pg_temp.ok(t.lifecycle = 'breaking', 'the closed table with a seat is back to breaking');
  PERFORM pg_temp.ok(t.break_started_at IS NOT NULL, 'break_started_at is stamped');
  PERFORM pg_temp.ok(pg_temp.events(g, 'closed_table_reopened_to_break', f) = 1, 'event closed_table_reopened_to_break');
  SELECT * INTO mv FROM public.cash_seat_moves WHERE game_id = g AND player_id = p AND state = 'pending' AND from_table_id = f;
  PERFORM pg_temp.ok(mv.id IS NOT NULL AND mv.to_table_id = m1, format('a move is planned for the stranded player onto Main 1 (reason %s)', mv.reason));
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
\echo '---- BOARD 8: a second chair in one game: the door refuses it; forced past the door, the tick settles it (20260905090006)'
BEGIN;
DO $$
DECLARE g uuid; a record; b record; seat_b integer; v_err text; refused boolean := false;
        newseat uuid; v_club uuid; t record; s record; ev record; bal_before numeric; bal_after numeric;
BEGIN
  -- a REAL live game with two open tables and a seated player: the oldest chair is theirs
  SELECT ts.user_id, ts.table_id, ts.stack, ts.club_id, tb.cluster_id AS game_id, ts.joined_at
    INTO a
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id JOIN public.cash_games cg ON cg.id = tb.cluster_id
   WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL AND coalesce(ts.stack, 0) > 0 AND coalesce(ts.leave_pending, false) = false
     AND tb.lifecycle = 'live' AND cg.must_move AND cg.enabled
     AND (SELECT count(*) FROM public.table_seats o WHERE o.user_id = ts.user_id AND o.left_at IS NULL) = 1
     AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'pending')
     -- a second table with a seat NUMBER that has no row at all: seat rows are
     -- unique per (table, seat) and a departed one is revived by UPDATE, and
     -- this board only ever INSERTs
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

  -- 1. the door
  BEGIN
    INSERT INTO public.table_seats (table_id, seat_number, user_id, stack, status, joined_at)
    VALUES (b.id, seat_b, a.user_id, a.stack, 'active', clock_timestamp());
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    refused := v_err LIKE 'ALREADY_IN_GAME%';
    RAISE NOTICE '      door: %', left(v_err, 100);
  END;
  PERFORM pg_temp.ok(refused, 'the door refuses a second chair in the same game (ALREADY_IN_GAME)');

  -- 2. past the door (the executor flag, as the pre-door fleet effectively was), then the tick
  PERFORM set_config('app.cash_seat_move', 'on', true);
  INSERT INTO public.table_seats (table_id, seat_number, user_id, stack, status, joined_at)
  VALUES (b.id, seat_b, a.user_id, a.stack, 'active', clock_timestamp()) RETURNING id INTO newseat;
  PERFORM set_config('app.cash_seat_move', '', true);
  SELECT club_id INTO v_club FROM public.table_seats WHERE id = newseat;   -- the wallet the cash-out credits
  PERFORM pg_temp.ok(newseat IS NOT NULL AND v_club IS NOT NULL, 'with the executor flag the second chair is seated (the pre-door shape)');

  -- 2a. on a RUNNING table: leave_pending, chips untouched (sub-block, undone after)
  BEGIN
    UPDATE public.tables SET status = 'running' WHERE id = b.id AND status <> 'running';
    PERFORM pg_temp.tick(g, 0);
    SELECT * INTO s FROM public.table_seats WHERE id = newseat;
    SELECT * INTO ev FROM public.cash_cluster_events WHERE game_id = g AND kind = 'second_chair_leave_pending' AND table_id = b.id AND at >= now();
    PERFORM pg_temp.ok(s.left_at IS NULL AND s.leave_pending, 'running table: the newer chair is flagged leave_pending for the hand boundary');
    PERFORM pg_temp.ok(ev.id IS NOT NULL AND (ev.payload->>'player_id')::uuid = a.user_id, 'event second_chair_leave_pending names the player');
    SELECT * INTO s FROM public.table_seats WHERE table_id = a.table_id AND user_id = a.user_id AND left_at IS NULL;
    PERFORM pg_temp.ok(s.id IS NOT NULL AND coalesce(s.leave_pending, false) = false, 'the older chair is untouched');
    RAISE EXCEPTION USING ERRCODE = 'P9999', MESSAGE = 'undo sub-board 2a';
  EXCEPTION WHEN SQLSTATE 'P9999' THEN NULL;
  END;

  -- 2b. on a WAITING table: cashed out now, through the tick's own path
  SELECT coalesce(chip_balance, 0) INTO bal_before FROM public.club_members WHERE user_id = a.user_id AND club_id = v_club;
  UPDATE public.tables SET status = 'waiting' WHERE id = b.id AND status <> 'waiting';
  PERFORM pg_temp.tick(g, 0);
  SELECT * INTO s FROM public.table_seats WHERE id = newseat;
  SELECT * INTO ev FROM public.cash_cluster_events WHERE game_id = g AND kind = 'second_chair_cashed_out' AND table_id = b.id AND at >= now();
  SELECT coalesce(chip_balance, 0) INTO bal_after FROM public.club_members WHERE user_id = a.user_id AND club_id = v_club;
  PERFORM pg_temp.ok(s.left_at IS NOT NULL, 'waiting table: the newer chair is cashed out now');
  PERFORM pg_temp.ok(ev.id IS NOT NULL AND ev.payload->>'where' = 'reconcile', 'event second_chair_cashed_out {where: reconcile}');
  PERFORM pg_temp.ok(bal_after - bal_before = a.stack, format('the stack (%s) went back to the club wallet (%s -> %s)', a.stack, bal_before, bal_after));
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.fn_unaccounted_seat_exits() u WHERE u.table_id = b.id), 'fn_unaccounted_seat_exits() has nothing for that table');
  SELECT * INTO s FROM public.table_seats WHERE table_id = a.table_id AND user_id = a.user_id AND left_at IS NULL;
  PERFORM pg_temp.ok(s.id IS NOT NULL, 'the older chair is still theirs');
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

\echo
\echo ================================================================
\echo  all ten boards passed; every transaction was rolled back
\echo ================================================================
