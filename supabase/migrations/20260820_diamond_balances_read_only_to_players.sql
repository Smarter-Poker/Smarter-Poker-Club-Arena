-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: 20260820_diamond_balances_read_only_to_players.sql (applied to prod)
--
-- CRITICAL — a player could mint themselves unlimited diamonds.
--
-- Found during the Club Arena storefront review. Diamonds are the real-money
-- currency (Stripe checkout) that the marketplace spends, and TWO tables that
-- hold a diamond balance were writable by the balance's owner:
--
--   public.diamond_wallets        "diamond_wallets_self"
--       FOR ALL, PUBLIC, USING (user_id = auth.uid()), WITH CHECK NULL
--   public.user_diamond_balance   "Users update own balance"
--       FOR UPDATE, PUBLIC, USING (auth.uid() = user_id), WITH CHECK NULL
--   public.user_diamond_balance   "Auto-create balance on first claim"
--       FOR INSERT, PUBLIC, WITH CHECK (auth.uid() = user_id)
--
-- When WITH CHECK is null Postgres reuses the USING expression as the check,
-- so the only condition on a write was "this row is mine" — nothing at all
-- constrained `balance`.
--
-- Verified against production in a rolled-back transaction, as a plain
-- authenticated user with no special role:
--     INSERT INTO diamond_wallets (user_id, balance) VALUES (me, 1000000)
--     ON CONFLICT (user_id) DO UPDATE SET balance = 1000000;
--   -> returned balance = 1000000.
-- Reachable from any browser with a valid session, straight through
-- PostgREST, with no server code involved.
--
-- Both tables are now SELECT-only for their owner. Nothing legitimate breaks:
--   * writers are server-side and use the service role, which has
--     rolbypassrls (WH pages/api/auth/ensure-profile.js, delete-account.js,
--     the Stripe checkout routes, and the SECURITY DEFINER grant/spend fns —
--     both tables are owned by postgres with force_rls off);
--   * the client only ever READS a balance (CA ClubLobby.tsx x3, the
--     marketplace wallet load, WH src/lib/authUtils.js).
--
-- Re-verified after applying: insert blocked (insufficient_privilege), update
-- affects 0 rows, own-balance SELECT still returns the row, and neither table
-- has any non-SELECT policy left for a non-service role.
--
-- ROLLBACK restores the vulnerability and should not be run. The exact
-- statements are recorded in each of the two applied migrations:
--   diamond_wallets_read_only_to_owner
--   user_diamond_balance_read_only_to_owner
-- ═══════════════════════════════════════════════════════════════════════════

-- ── diamond_wallets ──
DROP POLICY IF EXISTS "diamond_wallets_self" ON public.diamond_wallets;

CREATE POLICY "diamond_wallets_select_own"
  ON public.diamond_wallets
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- ── user_diamond_balance ──
DROP POLICY IF EXISTS "Users update own balance" ON public.user_diamond_balance;
DROP POLICY IF EXISTS "Auto-create balance on first claim" ON public.user_diamond_balance;
-- "Users view own balance" (SELECT) is intentionally left in place.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid IN ('public.diamond_wallets'::regclass,
                       'public.user_diamond_balance'::regclass)
      AND polcmd <> 'r'
      AND NOT ('service_role'::regrole = ANY(polroles))
  ) THEN
    RAISE EXCEPTION 'post-apply: a player-writable policy remains on a diamond balance table';
  END IF;
END $$;
