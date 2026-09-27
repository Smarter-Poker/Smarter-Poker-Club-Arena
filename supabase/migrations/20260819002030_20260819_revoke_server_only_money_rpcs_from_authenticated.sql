-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819002030 "20260819_revoke_server_only_money_rpcs_from_authenticated"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2077f3d65b1728acbfea4d1c88d01dc6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- CRITICAL: revoke four SECURITY DEFINER money/reporting RPCs from `authenticated`.
--
-- credit_club_wallet_rake IS A CHIP-MINTING HOLE.
--   SECURITY DEFINER (bypasses RLS), granted to `authenticated`, and it
--   performs no authorization of any kind - no auth.uid(), no role check, no
--   refusal path. Body does:
--       UPDATE club_wallets SET chip_balance = chip_balance + (p_rake - p_bbj)
--   with p_rake supplied entirely by the caller, plus a matching 'rake_in' row
--   in club_wallet_transactions.
--
--   PROVEN with a rolled-back probe as role `authenticated` carrying a real
--   player's JWT claim: minted 999,975.23 chips into SHARK CLUB inside the
--   transaction. ROLLBACK reverted it; real balance verified intact after.
--
--   Beyond minting, it forges rake accounting (period/lifetime_rake_collected
--   and BBJ contribution counters), which corrupts agent commission and
--   rakeback downstream because both derive from recorded rake.
--
-- The other three are not minting paths but leak or mutate across club
-- boundaries with no caller check, and none of them is client-called:
--   fn_sync_tournament_chips   - writes tournament chip state
--   get_daily_chip_summary     - cross-club chip reporting
--   sum_chip_transactions      - cross-club chip totals
--
-- SAFE TO REVOKE: verified every caller. credit_club_wallet_rake and
-- fn_sync_tournament_chips are called ONLY by the Hetzner engine
-- (club-arena/server/**, service_role). get_daily_chip_summary and
-- sum_chip_transactions are called ONLY by World Hub API routes
-- (service_role). ZERO client call sites for all four - grep across
-- club-arena/src, club-arena/server/src, World Hub pages+src, and
-- smarter-poker-workers/src.
--
-- service_role keeps EXECUTE, so every legitimate path is unaffected.
--
-- NOT touched here (deliberately): fn_apply_credit_payment,
-- fn_generate_credit_invoice and fn_generate_all_credit_invoices also lack
-- caller checks, but they ARE invoked from the browser (CreditService.ts,
-- FinancialCronService.ts). Revoking them would break the credit subsystem;
-- they need in-body authorization instead, handled separately.
-- ============================================================================

DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'public.credit_club_wallet_rake(uuid,numeric,numeric,uuid,integer)',
      'public.fn_sync_tournament_chips(uuid,jsonb)',
      'public.get_daily_chip_summary(uuid,text,integer)',
      'public.sum_chip_transactions(uuid,text,timestamptz,timestamptz)'
    ]) AS sig
  LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'Pre-flight: % does not exist with that signature - refusing to guess.', r.sig;
    END IF;
    IF has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN n := n + 1; END IF;
  END LOOP;

  IF n = 0 THEN
    RAISE EXCEPTION 'Pre-flight: none of the four are granted to authenticated - already fixed? Investigate before re-running.';
  END IF;
  RAISE NOTICE 'Pre-flight: % of 4 currently executable by authenticated.', n;
END $$;

REVOKE EXECUTE ON FUNCTION public.credit_club_wallet_rake(uuid,numeric,numeric,uuid,integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.credit_club_wallet_rake(uuid,numeric,numeric,uuid,integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_sync_tournament_chips(uuid,jsonb)                        FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_sync_tournament_chips(uuid,jsonb)                        FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_daily_chip_summary(uuid,text,integer)                   FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.get_daily_chip_summary(uuid,text,integer)                   FROM anon;
REVOKE EXECUTE ON FUNCTION public.sum_chip_transactions(uuid,text,timestamptz,timestamptz)    FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.sum_chip_transactions(uuid,text,timestamptz,timestamptz)    FROM anon;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'public.credit_club_wallet_rake(uuid,numeric,numeric,uuid,integer)',
      'public.fn_sync_tournament_chips(uuid,jsonb)',
      'public.get_daily_chip_summary(uuid,text,integer)',
      'public.sum_chip_transactions(uuid,text,timestamptz,timestamptz)'
    ]) AS sig
  LOOP
    IF has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'Post-apply: authenticated STILL has EXECUTE on %.', r.sig;
    END IF;
    IF has_function_privilege('anon', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'Post-apply: anon STILL has EXECUTE on %.', r.sig;
    END IF;
    -- The engine and the API routes must keep working.
    IF NOT has_function_privilege('service_role', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'Post-apply: service_role LOST EXECUTE on % - this would break the engine.', r.sig;
    END IF;
  END LOOP;
  RAISE NOTICE 'Post-apply OK: all four closed to clients, service_role retained.';
END $$;

-- ============================================================================
-- ROLLBACK (only if a genuine client path is discovered - prefer adding
-- in-body authorization to re-opening these):
--   GRANT EXECUTE ON FUNCTION public.credit_club_wallet_rake(uuid,numeric,numeric,uuid,integer) TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.fn_sync_tournament_chips(uuid,jsonb) TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_daily_chip_summary(uuid,text,integer) TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.sum_chip_transactions(uuid,text,timestamptz,timestamptz) TO authenticated;
-- ============================================================================
