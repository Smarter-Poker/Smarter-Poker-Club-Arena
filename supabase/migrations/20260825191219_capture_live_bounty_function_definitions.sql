-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825191219; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- No-op re-declaration: byte-faithful capture of the live definitions so the
-- repository holds the source of truth. See
-- supabase/migrations/20260825400000_capture_live_bounty_function_definitions.sql
SELECT 1;
