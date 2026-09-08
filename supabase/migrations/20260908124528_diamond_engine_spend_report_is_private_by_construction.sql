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
-- The same pass makes the claimed append-only record true in the schema:
-- every amount is positive, every row names its unique journal source, and no
-- application role can mutate or manufacture evidence directly.

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
  IF EXISTS (
    SELECT 1 FROM public.ca_diamond_engine_spend
     WHERE journal_id IS NULL OR amount <= 0
  ) THEN
    RAISE EXCEPTION 'diamond engine spend contains an unkeyed or non-positive row';
  END IF;
END $$;

ALTER FUNCTION public.fn_ca_diamond_engine_spent(text, text) SECURITY INVOKER;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_engine_spent(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_engine_spent(text, text) TO service_role;

-- Supabase's role-specific default ACL gives service_role every table right
-- and gives browser roles every sequence right. A later GRANT narrows nothing,
-- so revoke the defaults first and add back only the report read. Inserts are
-- performed by the postgres-owned ledger trigger, not by the application role.
REVOKE ALL ON TABLE public.ca_diamond_engine_spend
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ca_diamond_engine_spend TO service_role;

REVOKE ALL ON SEQUENCE public.ca_diamond_engine_spend_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.ca_diamond_engine_spend
  ALTER COLUMN journal_id SET NOT NULL;
ALTER TABLE public.ca_diamond_engine_spend
  ADD CONSTRAINT ca_diamond_engine_spend_amount_positive CHECK (amount > 0) NOT VALID;
ALTER TABLE public.ca_diamond_engine_spend
  VALIDATE CONSTRAINT ca_diamond_engine_spend_amount_positive;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_engine_spend_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'ca_diamond_engine_spend is append-only'
    USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_engine_spend_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS ca_diamond_engine_spend_is_immutable
  ON public.ca_diamond_engine_spend;
CREATE TRIGGER ca_diamond_engine_spend_is_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.ca_diamond_engine_spend
FOR EACH STATEMENT
EXECUTE FUNCTION public.fn_ca_diamond_engine_spend_is_immutable();

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
  IF NOT has_table_privilege('service_role', 'public.ca_diamond_engine_spend', 'SELECT')
     OR has_table_privilege('service_role', 'public.ca_diamond_engine_spend', 'INSERT')
     OR has_table_privilege('service_role', 'public.ca_diamond_engine_spend', 'UPDATE')
     OR has_table_privilege('service_role', 'public.ca_diamond_engine_spend', 'DELETE')
     OR has_table_privilege('service_role', 'public.ca_diamond_engine_spend', 'TRUNCATE') THEN
    RAISE EXCEPTION 'service_role diamond engine spend access is not append-only';
  END IF;
  IF has_sequence_privilege('anon', 'public.ca_diamond_engine_spend_id_seq', 'USAGE')
     OR has_sequence_privilege('anon', 'public.ca_diamond_engine_spend_id_seq', 'SELECT')
     OR has_sequence_privilege('anon', 'public.ca_diamond_engine_spend_id_seq', 'UPDATE')
     OR has_sequence_privilege('authenticated', 'public.ca_diamond_engine_spend_id_seq', 'USAGE')
     OR has_sequence_privilege('authenticated', 'public.ca_diamond_engine_spend_id_seq', 'SELECT')
     OR has_sequence_privilege('authenticated', 'public.ca_diamond_engine_spend_id_seq', 'UPDATE') THEN
    RAISE EXCEPTION 'a browser can reach the diamond engine spend sequence';
  END IF;
  IF has_sequence_privilege('service_role', 'public.ca_diamond_engine_spend_id_seq', 'USAGE')
     OR has_sequence_privilege('service_role', 'public.ca_diamond_engine_spend_id_seq', 'SELECT')
     OR has_sequence_privilege('service_role', 'public.ca_diamond_engine_spend_id_seq', 'UPDATE') THEN
    RAISE EXCEPTION 'service_role can manufacture diamond engine spend identifiers';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'ca_diamond_engine_spend'
       AND column_name = 'journal_id'
       AND is_nullable <> 'NO'
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.ca_diamond_engine_spend'::regclass
       AND conname = 'ca_diamond_engine_spend_amount_positive'
       AND convalidated
  ) THEN
    RAISE EXCEPTION 'diamond engine spend rows are not source-keyed positive evidence';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.ca_diamond_engine_spend'::regclass
       AND t.tgname = 'ca_diamond_engine_spend_is_immutable'
       AND NOT t.tgisinternal
       AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'diamond engine spend immutability trigger is missing';
  END IF;
END $$;

COMMIT;
