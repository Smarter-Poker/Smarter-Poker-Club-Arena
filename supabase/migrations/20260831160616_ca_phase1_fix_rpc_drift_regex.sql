-- BACKFILLED 2026-09-03 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831160616; the file committed at the time was a placeholder
-- marker (kept below) that said to export the body. Content is byte-exact to
-- what ran. Do NOT re-apply; it is already live.

-- ca_phase1_fix_rpc_drift_regex (prod 20260831160616). Canonical body lives in prod schema_migrations -
-- replace this marker byte-exact via scripts/dev/export-applied-migrations.sh.
-- Phase 1 fixup: \b is BACKSPACE in Postgres regex - \y is the word boundary; registry reseeded (190 fns).

-- PHASE 1 FIX: \b is a BACKSPACE in Postgres POSIX regexes (word boundary is
-- \y), so the registry seeded empty and the drift detector matched nothing.
-- Caught by phase-1 verification before claiming success.

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
SELECT DISTINCT p.proname, 'approved', 'grandfathered at phase-1 baseline (2026-08-31 audit)'
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f'
  AND p.prosrc ~* 'UPDATE\s+(public\.)?(club_members|club_wallets|union_wallets|unions|table_seats|bbj_pools|clubs|agents|wallets|spin_bonus_pools|tournament_players)\y'
ON CONFLICT (proname) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_drift()
RETURNS TABLE (proname text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT p.proname AS pn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND p.prosrc ~* 'UPDATE\s+(public\.)?(club_members|club_wallets|union_wallets|unions|table_seats|bbj_pools|clubs|agents|wallets|spin_bonus_pools|tournament_players)\y'
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
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_money_rpc_drift() FROM PUBLIC, anon, authenticated;
