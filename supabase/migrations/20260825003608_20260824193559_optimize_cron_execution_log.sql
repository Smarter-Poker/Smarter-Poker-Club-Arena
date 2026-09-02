-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825003608; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE INDEX IF NOT EXISTS idx_cron_execution_log_job_started 
ON public.cron_execution_log USING btree (job_name, started_at DESC);
