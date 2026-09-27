-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260510172436 "enable_pg_net_for_github_push"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 209ff1b2fb659e75c7333cac111635a0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
