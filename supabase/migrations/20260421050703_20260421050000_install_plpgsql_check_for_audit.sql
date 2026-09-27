-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260421050703 "20260421050000_install_plpgsql_check_for_audit"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 938739944381e5e2040c85694e8c397e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE EXTENSION IF NOT EXISTS plpgsql_check;
