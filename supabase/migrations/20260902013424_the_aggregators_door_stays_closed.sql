-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902013424; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- Restate the aggregator's live grants explicitly (measured already true:
-- anon false, authenticated false, service_role true). GRANT/REVOKE do not
-- trigger PostgREST reloads. Companion to the_newest_clamp_declaration_is_the_live_one.
REVOKE ALL ON FUNCTION public.fn_aggregate_gto_street_next(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_aggregate_gto_street_next(text, integer) TO service_role;
