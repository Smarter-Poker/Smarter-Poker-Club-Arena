-- 20260909165030_diamond_internal_writers_are_service_only.sql
--
-- Restate the live ACLs in immutable source after the custody migration
-- replaced these functions. All three write or snapshot the global Diamond
-- books and accept no authenticated player identity, so only the engine and
-- operator service role may execute them.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

REVOKE ALL ON FUNCTION
  public.add_diamonds_to_balance(uuid,integer,text,text,text),
  public.fn_ca_consume_purchase_lots(uuid,bigint),
  public.fn_ca_diamond_snapshot()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.add_diamonds_to_balance(uuid,integer,text,text,text),
  public.fn_ca_consume_purchase_lots(uuid,bigint),
  public.fn_ca_diamond_snapshot()
TO service_role;

DO $postcondition$
DECLARE
  v_proc regprocedure;
BEGIN
  FOREACH v_proc IN ARRAY ARRAY[
    'public.add_diamonds_to_balance(uuid,integer,text,text,text)'::regprocedure,
    'public.fn_ca_consume_purchase_lots(uuid,bigint)'::regprocedure,
    'public.fn_ca_diamond_snapshot()'::regprocedure
  ] LOOP
    IF NOT has_function_privilege('service_role', v_proc, 'EXECUTE')
       OR has_function_privilege('authenticated', v_proc, 'EXECUTE')
       OR has_function_privilege('anon', v_proc, 'EXECUTE')
       OR has_function_privilege('public', v_proc, 'EXECUTE') THEN
      RAISE EXCEPTION '% is not service-only', v_proc;
    END IF;
  END LOOP;
END;
$postcondition$;

COMMIT;
