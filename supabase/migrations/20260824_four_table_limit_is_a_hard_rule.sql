-- ═══════════════════════════════════════════════════════════════════════════
-- 20260824_four_table_limit_is_a_hard_rule.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- TIER:         2
-- AUTHOR:       Claude (Cowork), for Dan
-- AFFECTS:      one partial index and one BEFORE trigger on public.table_seats.
--               No table data rewritten.
-- IRREVERSIBLE: no (see ROLLBACK)
-- APPLIED:      2026-08-24 to kuklfnapbkmacvwxktbh as
--               `four_table_limit_is_a_hard_rule`, verified live (below).
--
-- Dan 2026-08-24, verbatim and BINDING:
--   "NO PLAYER OR HORSE CAN EVER PLAY MORE THEN 4 TABLES AT ONCE.
--    THIS IS A HARD RULE THAT SHOULDN'T BE BROKEN."
--
-- WHY A TRIGGER AND NOT AN APPLICATION CHECK
-- The application already had a four-game ceiling, added hours before this in
-- horseLoadMap. It is consulted by two call sites in one service. There are two
-- dozen database functions that write table_seats, plus a Node engine that
-- inserts directly. A rule enforced at call sites holds only until somebody
-- adds a twenty-fifth path - and this same session found TWO separate places
-- that had each forgotten a different mandatory call, one of them for long
-- enough that sixteen live Spins were advertising empty seats they had already
-- sold. Convention loses. The database does not.
--
-- table_seats is the chokepoint: a seat row IS the fact of playing a table, and
-- every path must create one.
--
-- WHAT COUNTS AS A TABLE
-- A row with left_at IS NULL at a table whose status is not 'closed'. Cash and
-- tournament alike - the rule says tables. A seat at a closed table is history.
--
-- COST
-- table_seats takes roughly 34,700 UPDATEs against 2,800 INSERTs per autovacuum
-- window and nearly every update is a stack change during play, which cannot
-- alter occupancy. The trigger is therefore scoped to INSERT and UPDATE OF
-- left_at and never sees them. The count is served by idx_table_seats_user_live,
-- a partial index over the few hundred live seats.
--
-- VERIFIED ON PRODUCTION AFTER APPLYING (all three, by probe, rolled back):
--   user with 3 live seats taking a 4th  -> ALLOWED
--   user with 4 live seats taking a 5th  -> REFUSED by this rule
--   user with 5 live seats taking a 6th  -> REFUSED by this rule
-- and hand production continued climbing across the change (13 -> 179/min),
-- so the limit is not blocking legitimate play.
-- ═══════════════════════════════════════════════════════════════════════════

-- Built CONCURRENTLY out of band on 2026-08-24 so the hot table was never
-- locked. IF NOT EXISTS keeps this file idempotent for a fresh environment.
CREATE INDEX IF NOT EXISTS idx_table_seats_user_live
  ON public.table_seats (user_id) WHERE left_at IS NULL;

DO $$
BEGIN
  IF to_regclass('public.table_seats') IS NULL THEN
    RAISE EXCEPTION 'table_seats missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public' AND indexname='idx_table_seats_user_live') THEN
    RAISE EXCEPTION 'idx_table_seats_user_live missing - the count would seq-scan a hot table';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_enforce_four_table_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_live      int;
  v_is_closed boolean;
BEGIN
  -- Only a row that OCCUPIES a seat can breach the limit. A row being vacated
  -- reduces the count and is always allowed.
  IF NEW.left_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT (t.status = 'closed') INTO v_is_closed FROM public.tables t WHERE t.id = NEW.table_id;
  IF COALESCE(v_is_closed, false) THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_live
  FROM public.table_seats ts
  JOIN public.tables t ON t.id = ts.table_id
  WHERE ts.user_id = NEW.user_id
    AND ts.left_at IS NULL
    AND t.status <> 'closed'
    -- Exclude this seat itself. On INSERT the row does not exist yet so this is
    -- a no-op; on UPDATE it stops a re-occupancy counting against itself.
    AND ts.id IS DISTINCT FROM NEW.id
    -- Re-seating at a table already occupied is not a new table.
    AND ts.table_id <> NEW.table_id;

  IF v_live >= 4 THEN
    RAISE EXCEPTION
      'FOUR TABLE LIMIT: user % is already seated at % tables and may not take another',
      NEW.user_id, v_live
      USING ERRCODE = '23514',
            HINT = 'Leave a table before joining another. This limit applies to players and horses alike.';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_four_table_limit ON public.table_seats;

CREATE TRIGGER trg_enforce_four_table_limit
BEFORE INSERT OR UPDATE OF left_at ON public.table_seats
FOR EACH ROW
EXECUTE FUNCTION public.fn_enforce_four_table_limit();

DO $$
DECLARE v_found int;
BEGIN
  SELECT count(*) INTO v_found
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE c.relname = 'table_seats'
     AND tg.tgname = 'trg_enforce_four_table_limit'
     AND NOT tg.tgisinternal;
  IF v_found <> 1 THEN
    RAISE EXCEPTION 'trigger was not created';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
--   DROP TRIGGER IF EXISTS trg_enforce_four_table_limit ON public.table_seats;
--   DROP FUNCTION IF EXISTS public.fn_enforce_four_table_limit();
--   DROP INDEX IF EXISTS public.idx_table_seats_user_live;
-- Dropping the trigger removes the hard limit and returns enforcement to the
-- application's advisory ceiling, which covers two call sites out of many.
-- ═══════════════════════════════════════════════════════════════════════════
