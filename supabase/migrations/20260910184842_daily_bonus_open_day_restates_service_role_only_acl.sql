-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260910184842; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260910184842   (the stamp IS the apply time, UTC: 2026-09-10 18:48:42)
--   name        daily_bonus_open_day_restates_service_role_only_acl
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1688 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260910184842 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     (no CREATE/DROP of a named object; see the body)
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- 20260910184705_daily_bonus_open_day_restates_service_role_only_acl.sql
--
-- The applied 181625 body replacement preserved the function's existing,
-- service-role-only ACL in PostgreSQL. Restate that security boundary in the
-- forward migration record so a clean replay and the static authorization gate
-- derive the same postimage as production.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';

DO $guard$
DECLARE
  v_oid oid := to_regprocedure('public.fn_ca_daily_bonus_open_day(uuid,date)');
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'DAILY_BONUS_OPEN_DAY_ACL_FUNCTION_MISSING';
  END IF;

  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_oid) THEN
    RAISE EXCEPTION 'DAILY_BONUS_OPEN_DAY_ACL_EXPECTED_SECURITY_DEFINER';
  END IF;
END;
$guard$;

REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_open_day(uuid, date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_open_day(uuid, date)
  TO service_role;

DO $postcondition$
DECLARE
  v_oid oid := 'public.fn_ca_daily_bonus_open_day(uuid,date)'::regprocedure;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl, acldefault('f', p.proowner))
      ) privilege
     WHERE p.oid = v_oid
       AND privilege.grantee = 0
       AND privilege.privilege_type = 'EXECUTE'
  )
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'DAILY_BONUS_OPEN_DAY_ACL_POSTCONDITION_FAILED';
  END IF;
END;
$postcondition$;

COMMIT;
