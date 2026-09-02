-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827061809; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The frozen-pool summary row describes a POOL, not an entity; the previous
-- migration writes it with entity_id NULL and the column was NOT NULL, so
-- reconcile_ledger_nightly raised 23502 at runtime. Pool-level rows may be
-- entity-less; every per-entity insert in the function still supplies an id.
ALTER TABLE public.ledger_reconcile_log ALTER COLUMN entity_id DROP NOT NULL;
