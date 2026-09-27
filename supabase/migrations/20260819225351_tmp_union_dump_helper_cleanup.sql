-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819225351 "tmp_union_dump_helper_cleanup"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e7d76ea08e7f146d7fb8fd57f4c628b8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

DROP FUNCTION IF EXISTS _lb_dump_union();
