-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829212453; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- REVERT v30_aggregator_own_timeout: statement_timeout is armed when the
-- OUTER statement starts, so a function-level SET never takes effect. A
-- config that claims to grant a budget but does not is a trap. The real
-- control is the caller's batch size (the engine driver uses small batches
-- with halving on timeout).
alter function public.fn_aggregate_gto_street_next(text, integer)
  reset statement_timeout;
