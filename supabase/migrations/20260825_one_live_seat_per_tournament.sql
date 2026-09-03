-- ═══════════════════════════════════════════════════════════════════════════
--  ONE LIVE SEAT PER TOURNAMENT  (2026-08-25)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT IS BROKEN
--
-- `idx_unique_active_user_per_table` is UNIQUE (table_id, user_id) WHERE
-- left_at IS NULL. It is scoped to ONE TABLE. Nothing in this database has
-- ever stopped one player holding live seats at two DIFFERENT tables of the
-- SAME tournament, and that state double-counts their chips: both seats are
-- dealt, both stacks diverge, and `fn_sync_tournament_chips` then resolves the
-- duplicate key by picking an arbitrary row.
--
-- Measured live 2026-08-25 on tournament bae46dbf-7cf6-42c0-a709-c38a97306a08
-- ("$100 Freeroll 12:00 PM"): 72 players holding 144 live seats across two
-- tables each, every pair written between 17:13:39 and 17:16:28 while the
-- start-seating pass was still running.
--
-- WHY A TRIGGER AND NOT AN INDEX
--
-- A partial unique index cannot express this. `table_seats` has no
-- tournament_id column - the tournament is reached through `tables`, and a
-- unique index may not span a join or call a non-immutable function. The
-- shape that CAN enforce it is a BEFORE trigger, which is how
-- `trg_enforce_four_table_limit` already enforces its own cross-row seat rule
-- on this same table.
--
-- WHAT IT DOES NOT DO
--
-- It does not touch, repair or delete the rows that are already duplicated -
-- deciding which of two diverged stacks is the real one is a money decision
-- and belongs to a human. A BEFORE trigger validates only the row being
-- written, so those 144 rows keep playing untouched. Normal play does not
-- fire it at all: it is armed on user_id / left_at / table_id, so the
-- per-hand `stack` writes skip it entirely.
--
-- ROLLBACK
--
--   DROP TRIGGER IF EXISTS trg_one_live_seat_per_tournament ON public.table_seats;
--   DROP FUNCTION IF EXISTS public.fn_guard_one_live_tournament_seat();

CREATE OR REPLACE FUNCTION public.fn_guard_one_live_tournament_seat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament_id uuid;
  v_other_table   uuid;
  v_other_seat    integer;
BEGIN
  -- A seat being vacated, or a seat with no occupant, cannot duplicate anyone.
  IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT t.tournament_id INTO v_tournament_id
  FROM public.tables t
  WHERE t.id = NEW.table_id;

  -- Cash tables are out of scope: a player may sit at several of them at once
  -- (that is what fn_enforce_four_table_limit bounds).
  IF v_tournament_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT ts.table_id, ts.seat_number
    INTO v_other_table, v_other_seat
  FROM public.table_seats ts
  JOIN public.tables t2 ON t2.id = ts.table_id
  WHERE ts.left_at IS NULL
    AND ts.user_id = NEW.user_id
    AND t2.tournament_id = v_tournament_id
    AND ts.id IS DISTINCT FROM NEW.id
  LIMIT 1;

  IF v_other_table IS NOT NULL THEN
    -- 23505 deliberately: every writer in the engine already treats a
    -- unique violation on a seat as "somebody else got there first" and
    -- stands down cleanly, which is exactly the behaviour wanted here.
    RAISE EXCEPTION
      'player % already holds a live seat in tournament % (table %, seat %) - one live seat per tournament',
      NEW.user_id, v_tournament_id, v_other_table, v_other_seat
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_one_live_seat_per_tournament ON public.table_seats;

CREATE TRIGGER trg_one_live_seat_per_tournament
BEFORE INSERT OR UPDATE OF user_id, left_at, table_id ON public.table_seats
FOR EACH ROW
WHEN (NEW.left_at IS NULL)
EXECUTE FUNCTION public.fn_guard_one_live_tournament_seat();

-- ── Post-apply assertions: the migration aborts on its own assumptions ──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.table_seats'::regclass
      AND tgname = 'trg_one_live_seat_per_tournament'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_one_live_seat_per_tournament was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_guard_one_live_tournament_seat'
  ) THEN
    RAISE EXCEPTION 'fn_guard_one_live_tournament_seat was not created';
  END IF;
END $$;
