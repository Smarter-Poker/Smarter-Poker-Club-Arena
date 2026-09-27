-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417221242 "phase22_revoke_disabled_sql_exec"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1db36cf46c7b61c41f06a2821f5b0057 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 22 — Revoke anon/authenticated from the 3 disabled SQL-exec
--  wrappers. Zero behavioral risk because their bodies already throw
--  'permanently disabled for security' regardless of caller. This is pure
--  defense-in-depth so these stop appearing in the anon-reachable
--  function surface.
--
--  Verified before shipping:
--    - exec_sql body:    RAISE EXCEPTION 'exec_sql is permanently disabled for security'
--    - run_sql body:     RAISE EXCEPTION 'run_sql is permanently disabled for security'
--    - pgmigrate body:   RETURN public.exec_sql(p_sql);  (inherits block above)
--
--  Nothing else touched this migration.
-- =========================================================================

REVOKE EXECUTE ON FUNCTION public.exec_sql(text)   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.run_sql(text)    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pgmigrate(text)  FROM PUBLIC, anon, authenticated;

-- service_role still has access (unchanged) for any legitimate admin tooling
-- that may have relied on them. Bodies still raise, so even service_role
-- gets the exception.

-- Mark these as resolved in the audit table
UPDATE public.phase22_secdef_grant_audit
   SET resolved_at = NOW(),
       resolution  = 'Phase 22: Revoked anon/authenticated EXECUTE. Function body already raises exception; this is pure defense-in-depth — now also removed from the anon-reachable surface enumeration.'
 WHERE function_name IN ('exec_sql', 'run_sql', 'pgmigrate');
