-- ZERO-DRIFT phase 2 (prod 2026-08-31 ~19:05 UTC): the money-RPC drift
-- detector matched only 'UPDATE <money table>' and missed upsert writers -
-- increment_union_wallet (INSERT INTO union_wallets ... ON CONFLICT DO
-- UPDATE) slipped the net. Widen the scan to INSERT INTO <money table> as
-- well, then grandfather the existing upsert writers it now sees (each
-- already audited: the auto-ledger triggers journal their writes;
-- increment_union_wallet is GUC-compliant as of 20260831190041).
CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_drift()
 RETURNS TABLE(proname text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT p.proname AS pn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND (
        p.prosrc ~* 'UPDATE\s+(public\.)?(club_members|club_wallets|union_wallets|unions|table_seats|bbj_pools|clubs|agents|wallets|spin_bonus_pools|tournament_players)\y'
        OR p.prosrc ~* 'INSERT\s+INTO\s+(public\.)?(club_members|club_wallets|union_wallets|unions|bbj_pools|clubs|agents|wallets|spin_bonus_pools)\y'
      )
      AND NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname = p.proname)
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_money_rpc_drift', 'unauthorized_adjustment', 'warning',
      'rpc-drift:' || r.pn,
      0, NULL, NULL, 'ledger', 'pg_proc', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'NEW unregistered function writes balance columns: ' || r.pn
        || ' — audit it, then register it in ca_money_rpc_registry',
      NULL, jsonb_build_object('proname', r.pn));
    proname := r.pn; RETURN NEXT;
  END LOOP;
END $function$;

-- Grandfather the upsert writers the widened scan now sees (audited today).
INSERT INTO public.ca_money_rpc_registry (proname, notes)
SELECT DISTINCT p.proname,
       'grandfathered 2026-08-31 phase 2: upsert-style writer caught by widened drift scan'
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f'
  AND p.prosrc ~* 'INSERT\s+INTO\s+(public\.)?(club_members|club_wallets|union_wallets|unions|bbj_pools|clubs|agents|wallets|spin_bonus_pools)\y'
  AND NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname = p.proname)
ON CONFLICT DO NOTHING;

-- The drift scanner is operator/engine telemetry, never a browser API
-- (closed in prod by 20260831161047 and re-stated here so this migration
-- is self-contained for a fresh environment).
REVOKE ALL ON FUNCTION public.fn_ca_money_rpc_drift() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_money_rpc_drift() TO service_role;
