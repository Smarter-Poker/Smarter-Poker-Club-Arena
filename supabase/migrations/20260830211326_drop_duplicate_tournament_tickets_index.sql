-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830211326; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 2026-08-30 DB-load pass, advisor finding `duplicate_index`:
-- tournament_tickets carries identical indexes tournament_tickets_holder_idx
-- and tournament_tickets_holder_status_idx. Every ticket write maintains both.
-- Keep the one whose name matches its actual shape; drop the other.
drop index if exists public.tournament_tickets_holder_idx;
