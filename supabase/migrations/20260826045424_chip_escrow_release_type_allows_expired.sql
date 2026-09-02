-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826045424; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

alter table public.chip_escrow
  drop constraint if exists chip_escrow_release_type_check;

alter table public.chip_escrow
  add constraint chip_escrow_release_type_check
  check (release_type = any (array['completed', 'cancelled', 'rejected', 'expired']));
