-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820015054 "diamond_wallets_read_only_to_owner"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 86189b1177fe1f2b3912bc7973f281f8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- CRITICAL: a player could mint themselves unlimited diamonds.
--
-- `diamond_wallets_self` was FOR ALL, granted to PUBLIC, with
--   USING (user_id = auth.uid())  and  WITH CHECK = NULL.
-- When WITH CHECK is null Postgres falls back to the USING expression, so the
-- only condition on INSERT/UPDATE was "the row is mine" — nothing constrained
-- `balance`. Verified against production in a rolled-back transaction: as a
-- plain authenticated user,
--   INSERT INTO diamond_wallets (user_id, balance) VALUES (me, 1000000)
--   ON CONFLICT (user_id) DO UPDATE SET balance = 1000000
-- succeeded and returned balance = 1000000.
--
-- Diamonds are the real-money currency (Stripe checkout) and the club shop
-- spends them, so this was a direct mint-your-own-money hole reachable from
-- any browser with a valid session, via PostgREST, with no server involved.
--
-- The client only ever SELECTs balance (three read sites in ClubLobby.tsx and
-- the marketplace wallet load), so read access is all it needs. Writers are
-- unaffected: service_role has rolbypassrls, and the table is owned by
-- postgres with force_rls off, so SECURITY DEFINER grant/spend functions
-- continue to work.
--
-- ROLLBACK (restores the hole — do not):
--   DROP POLICY diamond_wallets_select_own ON public.diamond_wallets;
--   CREATE POLICY diamond_wallets_self ON public.diamond_wallets
--     FOR ALL USING (user_id = (SELECT auth.uid()));
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.diamond_wallets'::regclass
                   AND polname='diamond_wallets_self') THEN
    RAISE EXCEPTION 'pre-flight: diamond_wallets_self not found — schema already changed?';
  END IF;
END $$;

DROP POLICY IF EXISTS "diamond_wallets_self" ON public.diamond_wallets;

-- Read-only, and only your own wallet.
CREATE POLICY "diamond_wallets_select_own"
  ON public.diamond_wallets
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

DO $$
DECLARE
  v_all int;
BEGIN
  SELECT count(*) INTO v_all FROM pg_policy
   WHERE polrelid='public.diamond_wallets'::regclass AND polcmd <> 'r';
  IF v_all > 0 THEN
    RAISE EXCEPTION 'post-apply: a non-SELECT policy still exists on diamond_wallets';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.diamond_wallets'::regclass
                   AND polname='diamond_wallets_select_own') THEN
    RAISE EXCEPTION 'post-apply: read policy missing';
  END IF;
END $$;
