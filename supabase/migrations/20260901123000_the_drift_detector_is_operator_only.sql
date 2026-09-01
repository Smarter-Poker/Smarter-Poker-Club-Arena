-- fn_ca_unledgered_insert_paths() went in as SECURITY DEFINER with the default
-- PUBLIC execute grant, which means anon could call it. The pre-push
-- definer-authorization gate caught it before the mirror landed, and it was
-- right: read-only is not the same as harmless. This one returns the shape of
-- the platform's ledger triggers, which is operator telemetry and nobody
-- else's business.
--
-- Closed the way that gate prescribes for diagnostics functions.

REVOKE ALL ON FUNCTION public.fn_ca_unledgered_insert_paths() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_unledgered_insert_paths() TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.fn_ca_unledgered_insert_paths()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still execute the drift detector';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_ca_unledgered_insert_paths()', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost execute on the drift detector';
  END IF;
END $$;
