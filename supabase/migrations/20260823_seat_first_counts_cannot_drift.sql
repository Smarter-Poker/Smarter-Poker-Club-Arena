-- ═══════════════════════════════════════════════════════════════════════════
-- 20260823_seat_first_counts_cannot_drift.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- TIER:         2
-- AUTHOR:       Claude (Cowork), for Dan
-- AFFECTS:      one new trigger on public.table_seats. No table data rewritten
--               beyond a one-time reconciliation of tournaments.current_players
--               and tables.current_players for OPEN seat-first games.
-- IRREVERSIBLE: no (DROP TRIGGER restores previous behaviour exactly)
--
-- WHY
--   A Spin or heads-up SNG starts on SEATS BOUGHT, so its lobby number must
--   come from the seat rows. `current_players` is a stored column and a seat
--   row does not touch it, so today every write path has to REMEMBER to call
--   fn_sync_seat_first_player_count.
--
--   That is a convention, and conventions lose. Measured live on 2026-08-23:
--   16 open Spins advertising "0/3" while holding 32 paid seats between them -
--   two of three sold, one seat from dealing, displayed as empty - plus 9 SNGs
--   the same. Two of those Spins were FULLY SOLD and still read zero. Two
--   separate call sites had forgotten the sync; after they were fixed and the
--   rows backfilled, 14 rows had drifted again within twenty minutes, because
--   seats also change OUTSIDE those call sites when a horse leaves or a human
--   sits down.
--
--   The asymmetry is the whole bug. `tournament_players` already carries
--   trg_sync_tournament_current_players, so an MTT's count CANNOT drift - the
--   database maintains it. `table_seats` has no equivalent, so the seat-first
--   half of the platform is maintained by hand. This adds the missing half.
--
-- WHY IT IS CHEAP, WHICH IS THE ONLY REASON IT IS SAFE HERE
--   table_seats is the hottest table on the platform: 34,668 UPDATEs against
--   2,779 INSERTs and 1,451 DELETEs in a single autovacuum window. Almost all
--   of those UPDATEs are stack changes during play, and a stack change cannot
--   alter how many seats are occupied.
--
--   So the trigger is scoped to the only three things that can:
--     INSERT           - somebody sat down
--     DELETE           - a seat row was removed
--     UPDATE OF left_at - somebody stood up, or a seat was reoccupied
--   plus a WHEN clause so even an UPDATE that writes left_at without changing
--   it does not fire. The ~34.7k stack updates never reach it.
--
--   The body then exits on its first statement for every CASH table, which is
--   a primary-key lookup returning tournament_id IS NULL.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Guard the assumptions this migration is built on ──────────────────────
DO $$
BEGIN
  IF to_regclass('public.table_seats') IS NULL THEN
    RAISE EXCEPTION 'table_seats does not exist - refusing to add a trigger to nothing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='table_seats' AND column_name='left_at'
  ) THEN
    RAISE EXCEPTION 'table_seats.left_at is gone - the trigger scope below is wrong';
  END IF;
  IF to_regprocedure('public.fn_sync_seat_first_player_count(uuid)') IS NULL THEN
    RAISE EXCEPTION 'fn_sync_seat_first_player_count(uuid) is missing - nothing to call';
  END IF;
END $$;

-- ── The trigger function ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_seat_change_syncs_seat_first_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_table_id uuid;
  v_tid      uuid;
BEGIN
  v_table_id := COALESCE(NEW.table_id, OLD.table_id);
  IF v_table_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- The cash-table exit. One PK lookup, and the overwhelming majority of seat
  -- changes on this platform stop here.
  SELECT tournament_id INTO v_tid FROM public.tables WHERE id = v_table_id;
  IF v_tid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Only seat-first formats derive their count from seats. An MTT's count is
  -- its registrations, already maintained by trg_sync_tournament_current_players
  -- on tournament_players; recomputing it from seats here would fight that
  -- trigger and re-create the very drift this migration exists to remove.
  IF NOT EXISTS (
    SELECT 1 FROM public.tournaments t
     WHERE t.id = v_tid
       AND (lower(t.variant) IN ('spin','sng') OR COALESCE(t.max_players,0) <= 2)
  ) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Same authoritative derivation the engine calls. Never throws the caller's
  -- transaction: a seat is real whether or not the shop window updated, and a
  -- failed count must never roll back somebody sitting down.
  BEGIN
    PERFORM public.fn_sync_seat_first_player_count(v_tid);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'seat-first count sync failed for tournament %: %', v_tid, SQLERRM;
  END;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trg_seat_change_syncs_seat_first_count ON public.table_seats;

-- The depth guard is defence in depth, not a fix for a live loop.
--
-- Checked at the time of writing: this trigger's only writes are
-- tables.current_players and tournaments.current_players, and every trigger on
-- those two tables that writes BACK to table_seats - trg_clear_seats_on_game_end,
-- trg_release_seats_on_tournament_finish, trg_on_table_status_change,
-- trg_tables_auto_cashout_on_close - is AFTER UPDATE OF status. None of them
-- can fire on a current_players write, so nothing recurses today.
--
-- It stays because that is four separate triggers' scopes away from being
-- true, on tables that several agents change, and an unbounded recursion here
-- would take the seat write down with it. Bounding the depth costs one integer
-- comparison per qualifying seat change.
--
-- Note also what is NOT expressible here: a WHEN clause cannot compare
-- OLD.left_at to NEW.left_at on a trigger that also covers INSERT and DELETE,
-- because OLD and NEW are null on those. `UPDATE OF left_at` already does the
-- work that matters - a statement that only writes a stack never mentions
-- left_at, so it never reaches this trigger at all.
CREATE TRIGGER trg_seat_change_syncs_seat_first_count
AFTER INSERT OR DELETE OR UPDATE OF left_at ON public.table_seats
FOR EACH ROW
WHEN (pg_trigger_depth() < 2)
EXECUTE FUNCTION public.fn_seat_change_syncs_seat_first_count();

-- ── One-time reconciliation of everything currently open ──────────────────
-- Ordered by id to take row locks in a stable order: the live engine writes
-- these same rows constantly and an unordered update deadlocked against it.
DO $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT t.id FROM public.tournaments t
     WHERE t.status = 'REGISTERING'
       AND (lower(t.variant) IN ('spin','sng') OR COALESCE(t.max_players,0) <= 2)
     ORDER BY t.id
  LOOP
    BEGIN
      PERFORM public.fn_sync_seat_first_player_count(r.id);
      n := n + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'backfill skipped % : %', r.id, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'seat-first reconciliation touched % tournament(s)', n;
END $$;

-- ── Post-apply assertions ─────────────────────────────────────────────────
DO $$
DECLARE
  v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing
    FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE c.relname = 'table_seats'
     AND tg.tgname = 'trg_seat_change_syncs_seat_first_count'
     AND NOT tg.tgisinternal;
  IF v_missing <> 1 THEN
    RAISE EXCEPTION 'trigger was not created';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
--   DROP TRIGGER IF EXISTS trg_seat_change_syncs_seat_first_count
--     ON public.table_seats;
--   DROP FUNCTION IF EXISTS public.fn_seat_change_syncs_seat_first_count();
--
-- Dropping the trigger restores the previous behaviour exactly: counts revert
-- to being maintained by the application call sites, and drift returns.
-- ═══════════════════════════════════════════════════════════════════════════
