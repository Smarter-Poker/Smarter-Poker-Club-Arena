-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819162305 "drop_ambiguous_increment_union_wallet_overload"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f64159d3a35e717c566df019cef370c3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The previous migration added defaulted params to increment_union_wallet,
-- which created a 4-arg overload alongside the legacy 2-arg version. A 2-arg
-- call now matches both (defaults make the 4-arg viable) — ambiguous overload
-- resolution would break every live caller. Drop the legacy version; the
-- 4-arg function with defaults serves 2-arg calls identically.
DROP FUNCTION IF EXISTS public.increment_union_wallet(uuid, numeric);

-- Preserve grants on the surviving function (match the original: it was called
-- by the service-role engine; keep it locked away from anon/authenticated).
REVOKE ALL ON FUNCTION public.increment_union_wallet(uuid, numeric, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_union_wallet(uuid, numeric, uuid, text) TO service_role;
