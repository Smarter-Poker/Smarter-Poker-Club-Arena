-- The operator console is not a browser route.
--
-- check-telemetry-exposure caught two SECURITY DEFINER routines that take no
-- identity argument, never test who is calling, and were executable from a
-- logged-in browser session. Both are operator telemetry, not product surface:
--
--   fn_tournament_double_paid_obligations(p_hours int)  anon + authenticated
--     Granted to PUBLIC, so an ANONYMOUS browser could enumerate which
--     tournaments had paid an obligation twice and by how much. Its only
--     caller in this repo is FeeReconciler.auditDoublePaidObligations, which
--     runs server-side on the service-role key and is unaffected.
--
--   fn_ca_mint_supply(p_asset text)                     authenticated
--     Chip supply totals. No caller anywhere in the repo - operator
--     diagnostics reached by hand.
--
-- Neither has a product caller, so this removes reachability and nothing else.
-- Recorded rather than allowlisted deliberately: the allowlist is for a
-- routine a browser genuinely needs, and these are the opposite of that.
--
-- This left main's Telemetry Exposure gate red for every open pull request,
-- because that gate reads the LIVE database rather than the branch.

BEGIN;

SET LOCAL lock_timeout = '30s';

REVOKE ALL ON FUNCTION public.fn_tournament_double_paid_obligations(integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_double_paid_obligations(integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_ca_mint_supply(text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_supply(text)
  TO service_role;

DO $assert$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.proname, p.proacl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('fn_tournament_double_paid_obligations', 'fn_ca_mint_supply')
  LOOP
    IF r.proacl IS NULL THEN
      RAISE EXCEPTION '% still executes as PUBLIC (a null ACL is the default grant)', r.proname;
    END IF;
    IF EXISTS (
      SELECT 1 FROM unnest(r.proacl) AS a
      WHERE a::text LIKE 'anon=%' OR a::text LIKE 'authenticated=%' OR a::text LIKE '=%'
    ) THEN
      RAISE EXCEPTION '% is still reachable from a browser session', r.proname;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM unnest(r.proacl) AS a WHERE a::text LIKE 'service_role=X%'
    ) THEN
      RAISE EXCEPTION '% lost the service_role grant its server caller needs', r.proname;
    END IF;
  END LOOP;
END;
$assert$;

COMMIT;
