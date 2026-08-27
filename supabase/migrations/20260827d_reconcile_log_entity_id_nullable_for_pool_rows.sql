-- APPLIED TO PRODUCTION 2026-08-27 via Supabase MCP apply_migration.
-- Pointer file; SQL body verbatim in supabase_migrations.schema_migrations
-- under 'reconcile_log_entity_id_nullable_for_pool_rows'.
-- ledger_reconcile_log.entity_id became nullable: the frozen-pool summary row
-- describes a POOL, not an entity, and the NOT NULL constraint made
-- reconcile_ledger_nightly raise 23502 at runtime (caught by execution,
-- transaction rolled back atomically, no rows lost).
SELECT 1; -- no-op locally; the real DDL is applied and recorded in the DB
