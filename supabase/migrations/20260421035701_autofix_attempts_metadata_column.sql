-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260421035701 "autofix_attempts_metadata_column"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 06fe427f2ef58a2662ed31ed1597e921 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- poll.mjs writes, phase-b-verify.mjs reads a `metadata` jsonb column.
-- Wave 1 migration omitted it; adding now so Phase B can run.
alter table public.autofix_attempts
  add column if not exists metadata jsonb not null default '{}'::jsonb;

comment on column public.autofix_attempts.metadata is
  'Schema-free breadcrumb blob: { snippet, dryRun, postMergeSha, verifyStartedAt, revertPrUrl, ... } written by poll.mjs + phase-b-verify.mjs.';
