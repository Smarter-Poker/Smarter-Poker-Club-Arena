-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902003126; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- The pre-push definer guard refused the disarmed atomic_chip_transfer: the
-- original consulted auth.role(), the refusal-only body does not, and a
-- SECURITY DEFINER function that never asks who is calling is exactly what
-- the guard exists to stop. A function whose whole body is RAISE EXCEPTION
-- touches nothing and needs nobody's rights: INVOKER.
ALTER FUNCTION public.atomic_chip_transfer(uuid, uuid, numeric, text, text, uuid, uuid) SECURITY INVOKER;
