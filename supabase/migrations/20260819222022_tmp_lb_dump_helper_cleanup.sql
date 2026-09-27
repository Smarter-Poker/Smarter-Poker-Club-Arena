-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819222022 "tmp_lb_dump_helper_cleanup"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 91dc3833d38af7c367b97601be0eb36d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Remove the temporary mirror-dump helper and the two backfill staging tables
-- now that both backfills are reconciled and verified.
DROP FUNCTION IF EXISTS _lb_dump_defs();
DROP TABLE IF EXISTS _lb_hands_daily;
DROP TABLE IF EXISTS _lb_backfill_daily;
