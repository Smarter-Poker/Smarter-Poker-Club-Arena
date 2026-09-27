-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260510172502 "enable_http_extension_for_github_push"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 26aae9bc5a0a2c658b5025e227af4aad of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;
