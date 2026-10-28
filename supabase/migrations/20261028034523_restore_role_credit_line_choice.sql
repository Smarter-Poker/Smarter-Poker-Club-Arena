-- Version reserved by scripts/new-migration.mjs.
-- Owner direction October 27, 2026: restore Prepaid / Credit Line and amount
-- beside rakeback in Promote And Demote. Supersedes the October 16 blanket ban.
-- Existing role RPC owns authorization, parent caps, audit and notification.
-- No balances, debt or existing terms are changed by this migration.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- Wallet-only callers that omit funding continue to create prepaid wallets.
ALTER TABLE public.agents
  DROP CONSTRAINT agents_are_prepaid,
  ALTER COLUMN is_prepaid SET DEFAULT true;

-- Keep the existing trigger identity and callers. Validate terms instead of
-- silently coercing an explicitly selected credit agreement to prepaid.
CREATE OR REPLACE FUNCTION public.fn_agent_default_prepaid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NEW.is_prepaid IS NULL OR NEW.credit_limit IS NULL
     OR NEW.credit_limit::text IN ('NaN', 'Infinity', '-Infinity')
     OR NEW.credit_limit < 0 THEN
    RAISE EXCEPTION 'Choose Valid Prepaid Or Credit Line Terms.' USING ERRCODE = '23514';
  END IF;
  IF NEW.is_prepaid AND NEW.credit_limit <> 0 THEN
    RAISE EXCEPTION 'A Prepaid Agent Carries No Credit Line.' USING ERRCODE = '23514';
  END IF;
  IF NOT NEW.is_prepaid AND NEW.credit_limit <= 0 THEN
    RAISE EXCEPTION 'A Credit Line Must Be Greater Than Zero.' USING ERRCODE = '23514';
  END IF;
  IF COALESCE(NEW.credit_used, 0) > NEW.credit_limit THEN
    RAISE EXCEPTION 'Settle Outstanding Credit Before Reducing The Line Or Choosing Prepaid.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

COMMIT;
