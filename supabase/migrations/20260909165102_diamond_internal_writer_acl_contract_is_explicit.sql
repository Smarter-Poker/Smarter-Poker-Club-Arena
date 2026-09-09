-- 20260909165200_diamond_internal_writer_acl_contract_is_explicit.sql
--
-- Repeat each service-only ACL as its own statement. Besides making the
-- database contract unambiguous, this is deliberately machine-readable by
-- the branch authorization gate, which evaluates one function signature per
-- GRANT or REVOKE statement.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

REVOKE ALL ON FUNCTION
  public.add_diamonds_to_balance(uuid,integer,text,text,text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.add_diamonds_to_balance(uuid,integer,text,text,text)
TO service_role;

REVOKE ALL ON FUNCTION
  public.fn_ca_consume_purchase_lots(uuid,bigint)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.fn_ca_consume_purchase_lots(uuid,bigint)
TO service_role;

REVOKE ALL ON FUNCTION
  public.fn_ca_diamond_snapshot()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
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
