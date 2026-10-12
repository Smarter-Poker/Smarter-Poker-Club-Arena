-- ============================================================================
-- A DIAMOND SEAT TAKES THE TABLE CAP BEFORE THE WALLET
-- ============================================================================
--
-- 20260930123828_a_diamond_seat_takes_the_table_cap_before_the_wallet.sql
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Phase 11 of the Diamond Arena programme, line 2: "Test transfer/store/game
-- concurrency, duplicate delivery and crash recovery". The concurrency suite
-- (tests/sql/run-diamond-concurrency.py) released one player's transfer, store
-- purchase, cash buy-in, top-up and tournament registration at the same
-- instant, against production's own doors, and the database answered the
-- buy-in "deadlock detected" - an unnamed refusal the client cannot explain,
-- after a one-second stall. Measured deterministically: a registration paused
-- inside its reserve, and the same player's cash buy-in arriving meanwhile,
-- deadlock every time.
--
-- Two locks, taken in two orders:
--
--   the Diamond cash buy-in, cash-out and seat exits take the player's
--   table-cap lock (hashtextextended('table_cap:' || user)) FIRST, and the
--   player's profile row - the Diamond wallet - after it;
--
--   a Diamond registration takes the profile row FIRST (fn_lock_daily_mission_user,
--   called by fn_ca_lock_tournament_seat_acquisition, locks it FOR NO KEY
--   UPDATE; the reserve then locks it FOR UPDATE) and the table-cap lock LAST,
--   in the roster trigger fn_enforce_booking_game_cap.
--
-- For a chip event the profile is not the wallet, so the chip estate never
-- met this; for a Diamond event it is, so a player's registration and cash
-- buy-in racing each other deadlock. The estate's own law is that two writers
-- of the same money take their locks in one order
-- (docs/laws.d/two-writers-of-the-same-money-take-their-locks-in-one-order.md).
-- So a Diamond seat acquisition now takes the table-cap lock before the Daily
-- Missions lock, and the trigger's later acquisition is re-entrant. The order
-- becomes one: table cap, then wallet, for every Diamond door. A chip event is
-- untouched - the new lock is taken only when the event's club is the Diamond
-- arena - and so is every lock the function already took, in its old order.
--
-- An asserted substitution on the live body: md5 pinned, the marker found
-- exactly once, the reverse substitution proved. fn_ca_lock_tournament_seat_acquisition
-- is not on fn_ca_guard_watchlist(); grants, owner, security and search_path are
-- kept by re-creating it from its own pg_get_functiondef. Nothing is opened,
-- nothing is priced.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_ca_lock_tournament_seat_acquisition   2d8c9bd676a8ee02e009dd470fbfd585
--   fn_enforce_booking_game_cap              (read, not changed: the lock it takes is the one taken here)
--
-- The migration creates no object, so it declares its own proof of being live:
-- @live-proof: position('hashtextextended(''table_cap:'' || p_user_id::text, 0)' in pg_get_functiondef('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'::regprocedure)) > 0
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. A DIAMOND SEAT ACQUISITION TAKES THE TABLE CAP BEFORE THE DAILY MISSIONS LOCK
-- ---------------------------------------------------------------------------
DO $table_cap_first$
DECLARE
  v_def text; v_after text; v_hits integer; v_cap text;
  v_old CONSTANT text := $old$  IF p_user_id IS NOT NULL THEN
    PERFORM public.fn_lock_daily_mission_user(p_user_id);
  END IF;$old$;
  v_new CONSTANT text := $new$  -- DIAMOND PHASE 11: a Diamond seat's player takes the table-cap lock before
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
  END IF;$new$;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'::regprocedure);
  IF md5(v_def) <> '2d8c9bd676a8ee02e009dd470fbfd585' THEN
    RAISE EXCEPTION 'fn_ca_lock_tournament_seat_acquisition changed (md5 %); re-read it before editing it', md5(v_def);
  END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'Daily Missions lock marker found % time(s), expected 1', v_hits;
  END IF;
  -- The lock taken here must be the very lock the roster trigger takes, or the order is not one.
  v_cap := pg_get_functiondef('public.fn_enforce_booking_game_cap()'::regprocedure);
  IF position('PERFORM pg_advisory_xact_lock(hashtextextended(''table_cap:'' || NEW.user_id::text, 0));' IN v_cap) = 0 THEN
    RAISE EXCEPTION 'fn_enforce_booking_game_cap no longer takes the table_cap lock this migration orders';
  END IF;
  IF position('hashtextextended(''table_cap:''||p_user_id,0)' IN
              pg_get_functiondef('public.fn_poker_diamond_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the Diamond buy-in no longer takes the table_cap lock first';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'::regprocedure);
  IF md5(replace(v_after, v_new, v_old)) <> '2d8c9bd676a8ee02e009dd470fbfd585' THEN
    RAISE EXCEPTION 'unrelated seat-acquisition text changed';
  END IF;
  IF has_function_privilege('anon', 'public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the seat-acquisition lock became reachable without an account';
  END IF;
END $table_cap_first$;

-- ---------------------------------------------------------------------------
-- 2. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_def text; v_bad text;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'::regprocedure);
  IF position('PERFORM pg_advisory_xact_lock(hashtextextended(''table_cap:'' || p_user_id::text, 0));' IN v_def) = 0
     OR position('PERFORM pg_advisory_xact_lock(hashtextextended(''table_cap:'' || p_user_id::text, 0));' IN v_def)
        > position('PERFORM public.fn_lock_daily_mission_user(p_user_id);' IN v_def)
     OR position('WHERE c.asset = ''diamonds''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'a Diamond seat acquisition does not take the table cap before the Daily Missions lock';
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
  RAISE NOTICE 'a Diamond seat takes the table cap before the wallet: one lock order for every Diamond door, chip events untouched, nothing opened';
END $m$;

COMMIT;
