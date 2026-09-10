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
