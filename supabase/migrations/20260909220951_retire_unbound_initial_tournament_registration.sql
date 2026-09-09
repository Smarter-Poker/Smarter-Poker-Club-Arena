-- Retire the initial registration API which has no operation identity.
-- PR 4028's receipt-bound client is verified live on public and origin build
-- 24a22ade8ac865b6f3ae4d3e0bc047e4bddff88d (2026-09-09 21:58:49 UTC).
-- The old one-argument alias only forwards to the two-argument internal core.
-- No active application source calls it. The receipt wrapper and seat-first
-- internal helper use the two-argument core, whose existing ACL is preserved.
-- Old clients fail before debit; they cannot bypass immutable request receipts.
-- This changes privileges only. No balances, historical records or jobs change.
BEGIN;
DO $require_live_registration_receipts$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid='public.fn_register_for_tournament_request(uuid,uuid)'::regprocedure
      AND prosecdef
      AND md5(prosrc)='c80d08529c03284adc51c6cb03764a55'
  ) OR NOT has_function_privilege(
    'authenticated','public.fn_register_for_tournament_request(uuid,uuid)','EXECUTE'
  ) OR has_function_privilege(
    'anon','public.fn_register_for_tournament_request(uuid,uuid)','EXECUTE'
  ) OR has_function_privilege(
    'service_role','public.fn_register_for_tournament_request(uuid,uuid)','EXECUTE'
  ) THEN
    RAISE EXCEPTION 'reviewed authenticated registration receipt wrapper is required';
  END IF;
  IF NOT has_function_privilege(
    'service_role','public.fn_register_for_tournament(uuid,boolean)','EXECUTE'
  ) OR has_function_privilege(
    'authenticated','public.fn_register_for_tournament(uuid,boolean)','EXECUTE'
  ) OR has_function_privilege(
    'anon','public.fn_register_for_tournament(uuid,boolean)','EXECUTE'
  ) THEN
    RAISE EXCEPTION 'internal seat-first registration core permissions changed';
  END IF;
END;
$require_live_registration_receipts$;

REVOKE ALL ON FUNCTION public.fn_register_for_tournament(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DO $assert_unbound_registration_retired$
BEGIN
  IF has_function_privilege('anon','public.fn_register_for_tournament(uuid)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_register_for_tournament(uuid)','EXECUTE')
     OR has_function_privilege('service_role','public.fn_register_for_tournament(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'unbound registration remains application-callable';
  END IF;
END;
$assert_unbound_registration_retired$;
NOTIFY pgrst, 'reload schema';
COMMIT;
