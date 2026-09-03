-- Close the browser door on the supply-accounting pair.
--
-- Production's ACL on fn_ca_supply_snapshot was already {postgres, service_role}
-- and CREATE OR REPLACE preserved it, so nothing was exposed by the preceding
-- migration. Two things still needed doing:
--
-- 1. That migration re-declared a SECURITY DEFINER writer without naming its
--    grants, so a replay on a fresh database would inherit the default and hand
--    it to anon and authenticated. check-definer-authorization blocked the push
--    for exactly this and it was right.
--
-- 2. fn_ca_noncirculating_chip_stores came out of CREATE holding
--    authenticated=X anyway. Supabase's default privileges grant EXECUTE on new
--    public functions, and 'REVOKE ALL FROM PUBLIC' does not touch a grant held
--    by a named role. The remedy has to name the roles, which is the same trap
--    the gate's own help text warns about from the other direction.
--
-- Neither function has any business being called from a browser: one is the
-- hourly supply snapshot, the other is a constant. Moves no money.

REVOKE ALL ON FUNCTION public.fn_ca_supply_snapshot()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_supply_snapshot() TO service_role;

REVOKE ALL ON FUNCTION public.fn_ca_noncirculating_chip_stores()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_noncirculating_chip_stores() TO service_role;

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.proname || ' -> ' || p.proacl::text, '; ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_ca_supply_snapshot','fn_ca_noncirculating_chip_stores')
     AND (p.proacl IS NULL
          OR array_to_string(p.proacl, ',') ~ '(^|,)(anon|authenticated)=');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'a browser role can still execute: %', bad;
  END IF;
  RAISE NOTICE 'both functions are service_role only';
END $$;
