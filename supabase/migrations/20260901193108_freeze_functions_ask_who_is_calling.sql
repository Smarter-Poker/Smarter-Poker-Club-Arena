-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901193108; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- The pre-push definer-authorization guard refused the freeze migration, and
-- was right three times over. One transaction, per the DDL policy.

-- 1. fn_platform_frozen does not need SECURITY DEFINER: the break row already
--    carries a public SELECT policy (maintenance_break_is_public), so INVOKER
--    reads exactly what any caller could read for themselves. Same resolution
--    as fn_maintenance_break_state on 2026-09-01.
ALTER FUNCTION public.fn_platform_frozen() SECURITY INVOKER;

-- 2 and 3. The per-minute cron movers were browser-callable: SECURITY DEFINER
--    with no explicit grant, which defaults to PUBLIC EXECUTE - so any anon
--    visitor could trigger a platform-wide seat-eviction sweep or a stalled
--    stack credit on demand. A pre-existing hole; redeclaring them in the
--    freeze migration made it ours to close. pg_cron runs them as postgres,
--    which no grant can refuse, so the jobs are unaffected.
REVOKE ALL ON FUNCTION public.fn_evict_sitting_out_cash_players() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_evict_sitting_out_cash_players() TO service_role;

REVOKE ALL ON FUNCTION public.fn_sweep_seatless_late_registrants() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sweep_seatless_late_registrants() TO service_role;

REVOKE ALL ON FUNCTION public.fn_credit_stalled_seat_first_stacks() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_credit_stalled_seat_first_stacks() TO service_role;
