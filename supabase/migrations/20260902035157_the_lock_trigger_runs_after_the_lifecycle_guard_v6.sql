-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902035157; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- Sorting the overlay/payout trigger after fn_guard_managed_game_lifecycle.
-- BEFORE row triggers fire in NAME order, so the guard must see what the
-- CALLER changed, not the engine's derived fields.
--
-- Five earlier attempts deadlocked or timed out: a trigger change on
-- `tournaments` takes an AccessExclusiveLock on realtime.subscription while
-- Supabase Realtime holds it and wants `tournaments`. The function detects
-- this rename at runtime, so nothing depended on it landing immediately.

SET LOCAL lock_timeout = '15s';

DROP TRIGGER IF EXISTS trg_ca_fund_overlay_on_lock ON public.tournaments;

CREATE TRIGGER zz_ca_fund_overlay_on_lock
  BEFORE UPDATE OF status ON public.tournaments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ca_fund_overlay_on_lock();

