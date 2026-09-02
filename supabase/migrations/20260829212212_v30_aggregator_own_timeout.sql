-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829212212; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The aggregator is bounded by its batch size, not by the caller's
-- statement_timeout: give it a budget that fits its largest legal batch.
alter function public.fn_aggregate_gto_street_next(text, integer)
  set statement_timeout = '120s';
