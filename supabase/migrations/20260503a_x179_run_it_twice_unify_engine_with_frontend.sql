-- x179 — Run-It-Twice flag unification (closes #179)
--
-- Problem (Round 61 Phase E re-audit):
--   Frontend writes `tables.run_it_twice` (boolean) when a user toggles RIT
--   on a table. Engine reads `tables.run_it_twice_enabled` (separate boolean
--   column) when offering the RIT prompt during all-ins. The two columns
--   were never kept in sync, so:
--     • All 28,691 production tables had run_it_twice = TRUE (frontend toggle
--       worked) but run_it_twice_enabled = FALSE (engine default).
--     • Net effect: RIT was silently disabled platform-wide. The frontend
--       UI showed RIT as enabled but the engine never offered it.
--
-- Fix:
--   1. Backfill: copy current run_it_twice → run_it_twice_enabled for any
--      row where the two diverge.
--   2. Sync trigger: keep them aligned going forward in BOTH directions, so
--      whichever column gets written, the other tracks. Lets us migrate to a
--      single column later without breaking either consumer.
--
-- Verification post-apply:
--   SELECT count(*) FROM tables WHERE run_it_twice IS DISTINCT FROM run_it_twice_enabled;
--   -- expected: 0 (was 28,691 pre-fix)
--
-- Applied to prod via Supabase MCP on 2026-05-03. This file is the
-- repo paper-trail copy; do NOT re-run on prod (idempotent but unnecessary).

UPDATE tables
SET run_it_twice_enabled = run_it_twice
WHERE run_it_twice_enabled IS DISTINCT FROM run_it_twice;

CREATE OR REPLACE FUNCTION public.fn_tables_sync_rit() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Whichever column was supplied, mirror to the other (NULL means caller
    -- didn't set it; let the column default win).
    IF NEW.run_it_twice_enabled IS NULL AND NEW.run_it_twice IS NOT NULL THEN
      NEW.run_it_twice_enabled := NEW.run_it_twice;
    ELSIF NEW.run_it_twice IS NULL AND NEW.run_it_twice_enabled IS NOT NULL THEN
      NEW.run_it_twice := NEW.run_it_twice_enabled;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- If only ONE column was changed in this UPDATE, propagate to the other.
    -- If both were changed (caller is being explicit), respect the caller's
    -- intent and don't override.
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
