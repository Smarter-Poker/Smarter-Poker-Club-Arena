-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503085138 "x179_run_it_twice_unify_engine_with_frontend"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3e5ce1c8731a1540a164d2b1e1bcbf73 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase J/K close-out: tables had THREE RIT columns (allow_run_it_twice,
-- run_it_twice, run_it_twice_enabled) drifting apart. R72 logged this as
-- cosmetic, but a final-sweep grep revealed:
--   - Frontend (TableCreationPage, CreateTableModal, TableService,
--     /api/create-table.js, HorseOrchestrator) writes to `run_it_twice`
--   - ServerTableEngine reads ONLY `run_it_twice_enabled`
--   - 28,691 of 28,691 tables: run_it_twice=true, run_it_twice_enabled=false
-- Net effect: every UI toggle the user flips for RIT does nothing.
-- The engine never offers RIT regardless of what the user picks.
--
-- Fix in two parts:
--   1. Backfill: set run_it_twice_enabled = run_it_twice on every existing row.
--   2. Sync trigger: future INSERT/UPDATE keeps both columns aligned so the
--      engine and frontend stay consistent until a separate cleanup
--      migration drops the redundant columns.

-- Part 1: backfill
UPDATE tables
SET run_it_twice_enabled = run_it_twice
WHERE run_it_twice_enabled IS DISTINCT FROM run_it_twice;

-- Part 2: sync trigger (BEFORE INSERT OR UPDATE)
CREATE OR REPLACE FUNCTION public.fn_tables_sync_rit() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  -- If only one was provided, mirror to the other. If both differ, prefer
  -- whichever was just changed: when run_it_twice changed, copy to enabled;
  -- otherwise copy enabled → run_it_twice.
  IF TG_OP = 'INSERT' THEN
    IF NEW.run_it_twice_enabled IS NULL AND NEW.run_it_twice IS NOT NULL THEN
      NEW.run_it_twice_enabled := NEW.run_it_twice;
    ELSIF NEW.run_it_twice IS NULL AND NEW.run_it_twice_enabled IS NOT NULL THEN
      NEW.run_it_twice := NEW.run_it_twice_enabled;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Detect which side changed and mirror to the other.
    IF NEW.run_it_twice IS DISTINCT FROM OLD.run_it_twice
       AND NEW.run_it_twice_enabled IS NOT DISTINCT FROM OLD.run_it_twice_enabled THEN
      NEW.run_it_twice_enabled := NEW.run_it_twice;
    ELSIF NEW.run_it_twice_enabled IS DISTINCT FROM OLD.run_it_twice_enabled
          AND NEW.run_it_twice IS NOT DISTINCT FROM OLD.run_it_twice THEN
      NEW.run_it_twice := NEW.run_it_twice_enabled;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_tables_sync_rit ON public.tables;
CREATE TRIGGER trg_tables_sync_rit
  BEFORE INSERT OR UPDATE ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.fn_tables_sync_rit();

