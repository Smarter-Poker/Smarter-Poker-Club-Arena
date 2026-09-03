-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902040205; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- Prevention for the 8.00 that sat outside the reserve for three hours.
-- DDL on `tournaments` takes AccessExclusiveLock and contends with the
-- realtime.subscription rebuild, which has deadlocked me repeatedly tonight.
-- lock_timeout makes this fail fast and retryable rather than picked as a
-- deadlock victim after holding the table.
SET LOCAL lock_timeout = '20s';

DROP TRIGGER IF EXISTS zz_ca_spin_cancel_returns_draw ON public.tournaments;
CREATE TRIGGER zz_ca_spin_cancel_returns_draw
  AFTER UPDATE OF status ON public.tournaments
  FOR EACH ROW
  WHEN (NEW.status IN ('CANCELLED','CANCELED'))
  EXECUTE FUNCTION public.fn_ca_spin_cancel_returns_draw();

