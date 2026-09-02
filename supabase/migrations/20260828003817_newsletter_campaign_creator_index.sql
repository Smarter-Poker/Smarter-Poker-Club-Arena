-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828003817; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Covers the auth.users foreign key used for administrator campaign audits.
begin;

create index if not exists newsletter_campaigns_created_by_idx
  on public.newsletter_campaigns (created_by)
  where created_by is not null;

commit;

