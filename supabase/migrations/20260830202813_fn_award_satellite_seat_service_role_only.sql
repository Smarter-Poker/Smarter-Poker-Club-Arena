-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830202813; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- fn_award_satellite_seat is engine-only: SECURITY DEFINER, writes money.
-- A browser role must not be able to execute it.
REVOKE ALL ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text) TO service_role;

