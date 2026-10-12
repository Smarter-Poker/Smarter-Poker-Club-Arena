-- ============================================================================
-- EVERY SEAT TAKES THE TABLE CAP BEFORE THE WALLET
-- ============================================================================
--
-- 20260930131333_every_seat_takes_the_table_cap_before_the_wallet.sql
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Phase 11 of the Diamond Arena programme, line 2: "Test transfer/store/game
-- concurrency, duplicate delivery and crash recovery". This finishes what
-- 20260930123828_a_diamond_seat_takes_the_table_cap_before_the_wallet began,
-- and undoes the one thing it got wrong.
--
-- Two per-player locks guard a seat: the player's table-cap lock
-- (hashtextextended('table_cap:' || user), the four-game limit) and the Daily
-- Missions lock, which locks the player's profile row FOR NO KEY UPDATE. For a
-- Diamond player that profile row is the wallet. Every cash seat door, chip and
-- Diamond - buy-in, cash-out, departure, seat move - takes the table cap before
-- any other lock it holds for that player. A tournament seat took the profile
-- row first (fn_ca_lock_tournament_seat_acquisition
-- calls fn_lock_daily_mission_user) and the table cap last, in the roster
-- trigger fn_enforce_booking_game_cap.
--
-- 20260930123828 put the table cap first for a DIAMOND event only, so a Diamond
-- registration and the same player's Diamond cash buy-in no longer deadlock. It
-- left a chip event on the old order, and so it made a new pair: one player's
-- chip registration (profile row, then table cap) and the same player's Diamond
-- registration (table cap, then profile row). The concurrency suite measured it
-- against production's own doors: a chip registration paused as its roster row
-- goes in, the same player's Diamond registration arriving meanwhile - "deadlock
-- detected", every time. The same chip registration meets the same player's
-- Diamond cash buy-in the same way, measured the same way; that pair is older
-- than either migration and waits only for the cash switch.
--
-- One order for every seat, whatever its asset: the seat acquisition takes the
-- table cap before the Daily Missions lock for every event. Before it, the
-- acquisition takes only the event's own settlement lane and two shared locks,
-- so for a registration the table cap becomes the first per-player lock; the
-- roster trigger's own table cap is re-entrant; and every cash door already
-- takes it first. A chip entry now waits on the same player's other seat door
-- at its first per-player lock instead of at its last. Nothing else moves:
-- every other lock the function takes keeps its place, what a chip entry
-- charges, seats and records is untouched, and no money moves differently.
--
-- An asserted substitution on the live body: md5 pinned, the marker found
-- exactly once, the reverse substitution proved. The marker is the block
-- 20260930123828 installed, byte for byte. fn_ca_lock_tournament_seat_acquisition
-- is not on fn_ca_guard_watchlist(); grants, owner, security and search_path are
-- kept by re-creating it from its own pg_get_functiondef. Nothing is opened,
-- nothing is priced.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_ca_lock_tournament_seat_acquisition   ed7023b1016b5268c50bc962b1cd0f09
--
-- The migration creates no object, so it declares its own proof of being live:
-- @live-proof: position('WHERE c.asset = ''diamonds''' in pg_get_functiondef('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'::regprocedure)) = 0 AND position('hashtextextended(''table_cap:'' || p_user_id::text, 0)' in pg_get_functiondef('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'::regprocedure)) BETWEEN 1 AND position('PERFORM public.fn_lock_daily_mission_user(p_user_id);' in pg_get_functiondef('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'::regprocedure))
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. EVERY SEAT ACQUISITION TAKES THE TABLE CAP BEFORE THE DAILY MISSIONS LOCK
-- ---------------------------------------------------------------------------
DO $every_seat_table_cap_first$
DECLARE
  v_def text; v_after text; v_hits integer;
  v_old CONSTANT text := $old$  -- DIAMOND PHASE 11: a Diamond seat's player takes the table-cap lock before
  -- the Daily Missions lock, which locks the player's profile - the Diamond wallet.
  -- The Diamond cash doors take table_cap first and the wallet after it; taken
  -- here, the roster trigger's own table_cap is re-entrant and the order is one.
  IF p_user_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.tournaments t JOIN public.clubs c ON c.id = t.club_id
        WHERE c.asset = 'diamonds'
          AND t.id = COALESCE(p_tournament_id,
                              (SELECT tb.tournament_id FROM public.tables tb WHERE tb.id = p_table_id))) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));
  END IF;
  IF p_user_id IS NOT NULL THEN
    PERFORM public.fn_lock_daily_mission_user(p_user_id);
  END IF;$old$;
  v_new CONSTANT text := $new$  -- DIAMOND PHASE 11: every seat's player takes the table-cap lock before the
  -- Daily Missions lock, which locks the player's profile row. Every cash seat
  -- door, chip and Diamond, takes table_cap first; for a Diamond player the
  -- profile row is the wallet, and one player's chip entry, Diamond entry and
  -- Diamond cash seat meet on these two locks, so the order is one for every
  -- event whatever its asset. The roster trigger's own table_cap is re-entrant.
  IF p_user_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));
    PERFORM public.fn_lock_daily_mission_user(p_user_id);
  END IF;$new$;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'::regprocedure);
  IF md5(v_def) <> 'ed7023b1016b5268c50bc962b1cd0f09' THEN
    RAISE EXCEPTION 'fn_ca_lock_tournament_seat_acquisition changed (md5 %); re-read it before editing it', md5(v_def);
  END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'the Diamond-only table-cap block found % time(s), expected 1', v_hits;
  END IF;
  -- The lock taken here must be the very lock the roster trigger and the cash
  -- seat doors take, or the order is not one.
  IF position('PERFORM pg_advisory_xact_lock(hashtextextended(''table_cap:'' || NEW.user_id::text, 0));' IN
              pg_get_functiondef('public.fn_enforce_booking_game_cap()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'fn_enforce_booking_game_cap no longer takes the table_cap lock this migration orders';
  END IF;
  IF position('hashtextextended(''table_cap:''||p_user_id,0)' IN
              pg_get_functiondef('public.fn_poker_diamond_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the Diamond cash buy-in no longer takes the table_cap lock first';
  END IF;
  IF position('hashtextextended(''table_cap:'' || p_user_id::text, 0)' IN
              pg_get_functiondef('public.atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the chip cash buy-in no longer takes the table_cap lock';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'::regprocedure);
  IF md5(replace(v_after, v_new, v_old)) <> 'ed7023b1016b5268c50bc962b1cd0f09' THEN
    RAISE EXCEPTION 'unrelated seat-acquisition text changed';
  END IF;
  IF has_function_privilege('anon', 'public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the seat-acquisition lock became reachable without an account';
  END IF;
END $every_seat_table_cap_first$;

-- ---------------------------------------------------------------------------
-- 2. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_def text; v_bad text; v_cap integer; v_dm integer;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'::regprocedure);
  v_cap := position('PERFORM pg_advisory_xact_lock(hashtextextended(''table_cap:'' || p_user_id::text, 0));' IN v_def);
  v_dm := position('PERFORM public.fn_lock_daily_mission_user(p_user_id);' IN v_def);
  IF v_cap = 0 OR v_dm = 0 OR v_cap > v_dm
     OR position('WHERE c.asset = ''diamonds''' IN v_def) <> 0 THEN
    RAISE EXCEPTION 'a seat acquisition does not take the table cap before the Daily Missions lock for every event';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open an arena switch';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'every seat takes the table cap before the wallet: one lock order for every event and every cash seat, nothing opened';
END $m$;

COMMIT;
