-- 20261016110416_the_invoice_deliverer_is_callable_by_the_service_role_only.sql
--
-- Applied to PokerIQ-Production with the Supabase MCP apply_migration, which
-- stamped version 20261016110416; this file carries that recorded version.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20261015184608 (cashout messages still reach players and agents) rebuilt
-- public.fn_deliver_accounting_invoice(uuid) with CREATE OR REPLACE. Postgres
-- keeps a function's grants across CREATE OR REPLACE, so production still holds
-- exactly what earlier migrations set: EXECUTE for postgres and service_role,
-- nothing for PUBLIC, anon or authenticated (read 2026-10-16 10:50 UTC,
-- proacl {postgres=X/postgres,service_role=X/postgres}).
--
-- The repository could not see that. Read on its own, the recorded migration
-- declares a SECURITY DEFINER writer with no auth.uid() check and no grant, so
-- scripts/ci/check-definer-authorization.mjs refuses it. This states the grant
-- the function already has, so the repository and production say the same
-- thing and a rebuild from the repository cannot open it to a browser. On
-- production it changes nothing.

BEGIN;

REVOKE ALL ON FUNCTION public.fn_deliver_accounting_invoice(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_deliver_accounting_invoice(uuid) TO service_role;

DO $verify$
BEGIN
  IF has_function_privilege('anon', 'public.fn_deliver_accounting_invoice(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_deliver_accounting_invoice(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_deliver_accounting_invoice(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_deliver_accounting_invoice grants are not service_role only';
  END IF;
END
$verify$;

-- @live-proof: (SELECT NOT has_function_privilege('anon', 'public.fn_deliver_accounting_invoice(uuid)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.fn_deliver_accounting_invoice(uuid)', 'EXECUTE') AND has_function_privilege('service_role', 'public.fn_deliver_accounting_invoice(uuid)', 'EXECUTE'))
COMMIT;
