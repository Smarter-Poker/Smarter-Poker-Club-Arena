-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260421040815 "autofix_attempts_sentry_issue_id_nullable_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8900eaf628a5b5431a155f1388e64632 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Multi-source table now. Vercel rows have no Sentry issue.
alter table public.autofix_attempts
  alter column sentry_issue_id drop not null;

-- Partial unique so we can't double-dispatch the same Vercel deployment,
-- and it can't collide with the Sentry path (different source).
create unique index if not exists autofix_attempts_vercel_deploy_uidx
  on public.autofix_attempts (source, deployment_id)
  where source = 'vercel' and deployment_id is not null;
