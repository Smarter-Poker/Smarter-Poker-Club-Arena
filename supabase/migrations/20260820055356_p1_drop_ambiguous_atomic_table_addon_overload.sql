-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820055356 "p1_drop_ambiguous_atomic_table_addon_overload"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 312c254854076a06d080f5326a8cee57 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- IMMEDIATE: adding p_idempotency_key created a SECOND function rather than
-- replacing the first, because CREATE OR REPLACE matches on the argument list.
-- Both now accept a 4-argument call (the 5th has a default), so every existing
-- add-on call is ambiguous -- PostgREST cannot choose a candidate and the call
-- fails outright. Drop the old 4-argument version; the 5-argument one is a
-- strict superset and every current call site resolves to it unchanged.
DROP FUNCTION IF EXISTS public.atomic_table_addon(uuid, uuid, numeric, boolean);
