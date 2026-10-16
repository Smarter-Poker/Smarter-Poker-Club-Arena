-- 20261016001952_agents_are_prepaid_and_carry_no_credit_line.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, October 2026: Club Arena agents have no credit lines; every agent is
-- prepaid from now on. Every agent row already reads that way (read before
-- this change: 146 rows, all is_prepaid, credit_limit 0, credit_used 0), but
-- nothing held it: the promote dialog, the Create Agent form, the agent
-- dashboard's Issue Credit action and the credit admin panel could each still
-- write a credit line, and fn_create_agent stored is_prepaid = false whenever
-- the caller left it out.
--
-- The rule now lives on the row itself, so every path obeys it:
--   * fn_agent_default_prepaid (BEFORE INSERT OR UPDATE OF is_prepaid,
--     credit_limit) refuses any credit_limit above 0 with a plain message and
--     stores every agent as prepaid with a zero line;
--   * the CHECK constraint agents_are_prepaid pins the same state.
-- The migration aborts unless every existing row already satisfies it, so no
-- agent's balance or terms move.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $assert$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM public.agents
   WHERE NOT coalesce(is_prepaid, false) OR coalesce(credit_limit, 0) <> 0
      OR coalesce(credit_used, 0) <> 0;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% agent rows carry credit; settle them before this rule', v_bad;
  END IF;
END
$assert$;

CREATE OR REPLACE FUNCTION public.fn_agent_default_prepaid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  -- Dan, October 2026: agents have no credit lines; every agent is prepaid.
  IF coalesce(NEW.credit_limit, 0) > 0 THEN
    RAISE EXCEPTION 'Agents Are Prepaid. Credit Lines Are Not Offered.'
      USING ERRCODE = '23514';
  END IF;
  NEW.is_prepaid := true;
  NEW.credit_limit := 0;
  RETURN NEW;
END
$function$;

DROP TRIGGER trg_agent_default_prepaid ON public.agents;
CREATE TRIGGER trg_agent_default_prepaid
  BEFORE INSERT OR UPDATE OF is_prepaid, credit_limit ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.fn_agent_default_prepaid();

ALTER TABLE public.agents
  ADD CONSTRAINT agents_are_prepaid CHECK (is_prepaid AND credit_limit = 0);

COMMENT ON CONSTRAINT agents_are_prepaid ON public.agents IS
  'Dan, October 2026: Club Arena agents have no credit lines; every agent is prepaid.';

COMMIT;
