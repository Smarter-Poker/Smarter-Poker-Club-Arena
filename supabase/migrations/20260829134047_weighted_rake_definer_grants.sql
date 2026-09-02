-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829134047; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

REVOKE ALL ON FUNCTION public.fn_rakeback_recompute_periods(uuid, date, date, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_recompute_periods(uuid, date, date, uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.fn_close_settlement_period(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_close_settlement_period(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_club_rake_rollup_day(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_rake_rollup_day(uuid, date) TO service_role;

REVOKE ALL ON FUNCTION public.fn_bbj_rollup_day(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_rollup_day(uuid, date) TO service_role;
