-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828071730; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Full write-up: supabase/migrations/20260828_the_four_table_claim_is_atomic_and_counts_bookings.sql
-- Measured 2026-08-28: 24 accounts over the four-game cap, ZERO of them over
-- on live seats. Every breach was a BOOKING, and bookings had no enforcement
-- at all -- four application callers each read the load, each passed, then all
-- booked. Both triggers now take the same per-account advisory lock
-- ('table_cap:' || user_id) that atomic_table_buyin has used since 2026-08-19,
-- which is what makes check-and-claim indivisible across all three paths.
-- No is_horse anywhere: identical rule for players and horses (CLAUDE.md 10.5).

CREATE OR REPLACE FUNCTION public.fn_concurrent_game_load(
  p_user_id               uuid,
  p_exclude_seat_id       uuid DEFAULT NULL,
  p_exclude_table_id      uuid DEFAULT NULL,
  p_exclude_tournament_id uuid DEFAULT NULL
)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT (
    -- (1) A LIVE SEAT IS A GAME. A seat at a closed table is history.
    (
      SELECT count(*)
        FROM public.table_seats ts
        JOIN public.tables t ON t.id = ts.table_id
       WHERE ts.user_id = p_user_id
         AND ts.left_at IS NULL
         AND t.status <> 'closed'
         AND (p_exclude_seat_id IS NULL OR ts.id IS DISTINCT FROM p_exclude_seat_id)
         AND (p_exclude_table_id IS NULL OR ts.table_id IS DISTINCT FROM p_exclude_table_id)
    )
    +
    -- (2) A BOOKING IS A GAME ONLY UNTIL ITS TOURNAMENT STARTS. RUNNING is
    -- absent deliberately: its entrants hold seats, counted by clause (1).
    (
      SELECT count(*)
        FROM public.tournament_players tp
        JOIN public.tournaments tr ON tr.id = tp.tournament_id
       WHERE tp.user_id = p_user_id
         AND tp.status IN ('registered', 'playing')
         AND tr.status IN ('ANNOUNCED', 'REGISTERING')
         AND (p_exclude_tournament_id IS NULL
              OR tp.tournament_id IS DISTINCT FROM p_exclude_tournament_id)
         -- NEVER BOTH. A seat-first game sells the chair before it starts, so
         -- a booking and a seat can describe the same game for a few minutes.
         AND NOT EXISTS (
           SELECT 1
             FROM public.table_seats ts2
             JOIN public.tables t2 ON t2.id = ts2.table_id
            WHERE ts2.user_id = p_user_id
              AND ts2.left_at IS NULL
              AND t2.status <> 'closed'
              AND t2.tournament_id = tp.tournament_id
         )
    )
  )::int;
$function$;

COMMENT ON FUNCTION public.fn_concurrent_game_load(uuid, uuid, uuid, uuid) IS
  'Concurrent games for one account: live seats at open tables plus bookings for tournaments that have not started, never double-counting a seat-first chair. Players and horses alike (CLAUDE.md 10.5).';

CREATE INDEX IF NOT EXISTS idx_tournament_players_user_open
  ON public.tournament_players (user_id)
  WHERE status IN ('registered', 'playing');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND indexname = 'idx_tournament_players_user_open') THEN
    RAISE EXCEPTION 'idx_tournament_players_user_open missing - every seat INSERT would scan a 160k-row table';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND indexname = 'idx_table_seats_user_live') THEN
    RAISE EXCEPTION 'idx_table_seats_user_live missing - clause (1) would seq-scan a hot table';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_enforce_four_table_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_live       int;
  v_is_closed  boolean;
  v_tournament uuid;
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT (t.status = 'closed'), t.tournament_id
    INTO v_is_closed, v_tournament
    FROM public.tables t
   WHERE t.id = NEW.table_id;
  IF COALESCE(v_is_closed, false) THEN
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
$function$;

DROP TRIGGER IF EXISTS trg_enforce_four_table_limit ON public.table_seats;

CREATE TRIGGER trg_enforce_four_table_limit
BEFORE INSERT OR UPDATE OF left_at ON public.table_seats
FOR EACH ROW
EXECUTE FUNCTION public.fn_enforce_four_table_limit();

CREATE OR REPLACE FUNCTION public.fn_enforce_booking_game_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_load    int;
  v_tstatus text;
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS NULL OR NEW.status NOT IN ('registered', 'playing') THEN
    RETURN NEW;
  END IF;

  -- registered -> playing at late registration is not a NEW claim.
  IF TG_OP = 'UPDATE' AND OLD.status IN ('registered', 'playing') THEN
    RETURN NEW;
  END IF;

  SELECT tr.status INTO v_tstatus
    FROM public.tournaments tr
   WHERE tr.id = NEW.tournament_id;

  -- Once under way, entrants are counted by their SEATS and the seat trigger
  -- owns the rule. An unreadable tournament row is checked, not waved through.
  IF v_tstatus IS NOT NULL AND v_tstatus NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || NEW.user_id::text, 0));

  v_load := public.fn_concurrent_game_load(NEW.user_id, NULL, NULL, NEW.tournament_id);

  IF v_load >= 4 THEN
    RAISE EXCEPTION
      'FOUR TABLE LIMIT: user % is already committed to % games and may not enter another',
      NEW.user_id, v_load
      USING ERRCODE = '23514',
            HINT = 'Leave a table or unregister before entering another. A game is a live seat or a booking for a tournament that has not started. This limit applies to players and horses alike.';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_booking_game_cap ON public.tournament_players;

-- UPDATE OF status, not UPDATE: the 5s chip sync writes .chips for every live
-- entrant and must never pay for this check.
CREATE TRIGGER trg_enforce_booking_game_cap
BEFORE INSERT OR UPDATE OF status ON public.tournament_players
FOR EACH ROW
EXECUTE FUNCTION public.fn_enforce_booking_game_cap();

DO $$
DECLARE v_found int;
BEGIN
  SELECT count(*) INTO v_found
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE c.relname = 'table_seats' AND tg.tgname = 'trg_enforce_four_table_limit'
     AND NOT tg.tgisinternal;
  IF v_found <> 1 THEN RAISE EXCEPTION 'seat trigger was not created'; END IF;

  SELECT count(*) INTO v_found
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE c.relname = 'tournament_players' AND tg.tgname = 'trg_enforce_booking_game_cap'
     AND NOT tg.tgisinternal;
  IF v_found <> 1 THEN RAISE EXCEPTION 'booking trigger was not created'; END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('fn_enforce_four_table_limit', 'fn_enforce_booking_game_cap')
         AND p.prosrc LIKE '%pg_advisory_xact_lock%') <> 2 THEN
    RAISE EXCEPTION 'a four-table trigger is counting without holding the per-account lock';
  END IF;

  IF (SELECT count(*) FROM (SELECT ts.user_id
        FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
       WHERE ts.left_at IS NULL AND t.status <> 'closed'
       GROUP BY 1 HAVING count(*) > 4) q) <> 0 THEN
    RAISE EXCEPTION 'an account already holds more than four live seats - fix the data before tightening the rule';
  END IF;
END $$;
