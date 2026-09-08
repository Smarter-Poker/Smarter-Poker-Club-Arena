-- 20260908124528_diamond_engine_spend_report_is_private_by_construction.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- The spend reader was created SECURITY DEFINER even though both legitimate
-- callers already run with operator authority and the backing tables are
-- private. Elevation is unnecessary here and would turn a future accidental
-- EXECUTE grant into a route around the table boundary.
--
-- Make the helper SECURITY INVOKER, retain its read-only STABLE contract, and
-- assert both layers of the service-only boundary in the same transaction.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '2min';

DO $$
BEGIN
  IF to_regprocedure('public.fn_ca_diamond_engine_spent(text,text)') IS NULL THEN
    RAISE EXCEPTION 'fn_ca_diamond_engine_spent(text,text) is missing';
  END IF;
  IF to_regclass('public.ca_diamond_engine_spend') IS NULL
     OR to_regclass('public.diamond_reward_budgets') IS NULL THEN
    RAISE EXCEPTION 'diamond spend report backing storage is missing';
  END IF;
END $$;

ALTER FUNCTION public.fn_ca_diamond_engine_spent(text, text) SECURITY INVOKER;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_engine_spent(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_engine_spent(text, text) TO service_role;

DO $$
DECLARE
  v_is_definer boolean;
  v_volatility "char";
BEGIN
  SELECT p.prosecdef, p.provolatile
    INTO v_is_definer, v_volatility
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.oid = 'public.fn_ca_diamond_engine_spent(text,text)'::regprocedure;

  IF v_is_definer THEN
    RAISE EXCEPTION 'diamond engine spend report still elevates its caller';
  END IF;
  IF v_volatility <> 's' THEN
    RAISE EXCEPTION 'diamond engine spend report lost its read-only STABLE contract';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_ca_diamond_engine_spent(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_ca_diamond_engine_spent(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'diamond engine spend report is browser-executable';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.fn_ca_diamond_engine_spent(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'diamond engine spend report is not service-executable';
  END IF;
  IF has_table_privilege('anon', 'public.ca_diamond_engine_spend', 'SELECT')
     OR has_table_privilege('authenticated', 'public.ca_diamond_engine_spend', 'SELECT')
     OR has_table_privilege('anon', 'public.diamond_reward_budgets', 'SELECT')
     OR has_table_privilege('authenticated', 'public.diamond_reward_budgets', 'SELECT') THEN
    RAISE EXCEPTION 'a browser can read diamond engine spend through its backing tables';
  END IF;
END $$;

COMMIT;
