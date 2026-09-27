-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820000020 "tmp_dump_helper_v3_cleanup"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d4e1020f115076fe479f00e135b0005e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

DROP FUNCTION IF EXISTS _lb_dump3();
