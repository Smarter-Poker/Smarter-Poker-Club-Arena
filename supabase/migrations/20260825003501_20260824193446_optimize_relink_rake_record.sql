-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825003501; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE INDEX IF NOT EXISTS idx_rake_records_relink 
ON public.rake_records (table_id, (metadata->>'hand_number')) 
WHERE hand_id IS NULL;
