-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820015356 "user_diamond_balance_read_only_to_owner"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7e4ef585708c5a4c47b4eec6364d8002 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Second instance of the mint-your-own-diamonds hole, found by sweeping every
-- money table for write policies with no WITH CHECK of their own.
--
-- public.user_diamond_balance (5 rows, 456,445 diamonds) had:
--   "Users update own balance"        UPDATE, PUBLIC, USING (auth.uid()=user_id),
--                                     WITH CHECK NULL  -> USING is reused as the
--                                     check, so nothing constrained `balance`.
--   "Auto-create balance on first claim" INSERT, PUBLIC,
--                                     WITH CHECK (auth.uid()=user_id) -> a user
--                                     with no row (most of them: 416 wallets
--                                     exist in diamond_wallets vs 5 rows here)
--                                     could insert themselves any balance.
--
-- Writers are server-side and use the service role, which bypasses RLS:
--   WH pages/api/auth/ensure-profile.js  (creates the row)
--   WH pages/api/auth/delete-account.js  (removes it)
-- The client only ever reads it:
--   WH src/lib/authUtils.js -> /rest/v1/user_diamond_balance?select=balance
-- so SELECT is all authenticated users need.
--
-- ROLLBACK (restores the hole — do not):
--   CREATE POLICY "Users update own balance" ON public.user_diamond_balance
--     FOR UPDATE USING ((SELECT auth.uid()) = user_id);
--   CREATE POLICY "Auto-create balance on first claim" ON public.user_diamond_balance
--     FOR INSERT WITH CHECK ((SELECT auth.uid()) = user_id);
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.user_diamond_balance'::regclass
                   AND polname='Users update own balance') THEN
    RAISE EXCEPTION 'pre-flight: expected write policy not found — schema already changed?';
  END IF;
END $$;

DROP POLICY IF EXISTS "Users update own balance" ON public.user_diamond_balance;
DROP POLICY IF EXISTS "Auto-create balance on first claim" ON public.user_diamond_balance;

DO $$
DECLARE v_writes int;
BEGIN
  SELECT count(*) INTO v_writes FROM pg_policy
   WHERE polrelid='public.user_diamond_balance'::regclass
     AND polcmd <> 'r'
     AND NOT ('service_role'::regrole = ANY(polroles));
  IF v_writes > 0 THEN
    RAISE EXCEPTION 'post-apply: % non-service write policy/policies remain', v_writes;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.user_diamond_balance'::regclass
                   AND polcmd='r') THEN
    RAISE EXCEPTION 'post-apply: users can no longer read their own balance';
  END IF;
END $$;
