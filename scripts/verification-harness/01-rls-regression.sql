-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase F-2 #1 — RLS Regression Test (Hole Cards God-Mode Defense)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Validates FIX 141 — the god-mode policy is GONE and per-user policy is in effect.
--
-- Run: supabase db execute --file scripts/verification-harness/01-rls-regression.sql
-- Or:  paste into Supabase SQL Editor (must be run as authenticated user, not service role)
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Confirm the god-mode policy is GONE
SELECT
  'TEST_1_GODMODE_POLICY_DROPPED' AS test,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'table_hole_cards'
        AND policyname IN ('hole_cards_all', 'allow_all', 'public_select')
    )
    THEN 'FAIL — permissive policy still exists'
    ELSE 'PASS'
  END AS result;

-- 2. Confirm per-user SELECT policy is in effect
SELECT
  'TEST_2_PER_USER_SELECT_POLICY_EXISTS' AS test,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'table_hole_cards'
        AND cmd = 'SELECT'
        AND qual LIKE '%auth.uid()%'
    )
    THEN 'PASS'
    ELSE 'FAIL — no per-user SELECT policy with auth.uid() found'
  END AS result;

-- 3. List ALL policies on table_hole_cards (audit)
SELECT
  'TEST_3_AUDIT_ALL_POLICIES' AS test,
  policyname,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'table_hole_cards'
ORDER BY policyname;

-- 4. Confirm RLS is ENABLED on table_hole_cards
SELECT
  'TEST_4_RLS_ENABLED' AS test,
  CASE
    WHEN rowsecurity THEN 'PASS'
    ELSE 'FAIL — RLS not enabled on table_hole_cards'
  END AS result
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'table_hole_cards';

-- 5. Confirm RLS is ENABLED on financial tables
SELECT
  'TEST_5_FINANCIAL_RLS' AS test,
  tablename,
  CASE WHEN rowsecurity THEN 'PASS' ELSE 'FAIL — RLS not enabled' END AS result
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'wallets',
    'wallet_transactions',
    'cashout_requests',
    'rakeback_periods',
    'agent_settlements',
    'chip_transactions',
    'feature_purchases',
    'vip_subscriptions'
  )
ORDER BY tablename;

-- 6. Confirm SECURITY DEFINER on critical RPCs
SELECT
  'TEST_6_SECURITY_DEFINER_RPCS' AS test,
  proname AS function_name,
  CASE
    WHEN prosecdef THEN 'PASS — SECURITY DEFINER'
    ELSE 'FAIL — runs with caller perms (not SECURITY DEFINER)'
  END AS result
FROM pg_proc
WHERE proname IN (
  -- Atomic wallet/table ops
  'atomic_table_buyin', 'atomic_table_cashout', 'atomic_table_rebuy',
  'atomic_credit_wallet_and_log', 'atomic_deduct_wallet_and_log', 'atomic_wallet_transfer',
  'wallet_internal_transfer', 'wallet_user_transfer',
  -- Cashout flow
  'fn_request_cashout', 'fn_approve_cashout_atomic', 'fn_complete_cashout',
  'fn_cancel_cashout_atomic', 'fn_reject_cashout',
  -- Union ops
  'fn_union_send_chips_to_club', 'fn_union_credit_wallet', 'fn_union_debit_wallet',
  'increment_union_chip_balance', 'increment_union_rake', 'verify_and_log_union_rakeback',
  -- Club / agent ops
  'mint_club_chips', 'mint_club_promo',
  'transfer_promo_union_to_agent', 'transfer_promo_union_to_club',
  -- increment_agent_rake was here. Phase 7 dropped it (2026-09-01): it was the
  -- only writer of agents.pending_commission anywhere in the database and it
  -- had no caller, which is why that column froze at 26,859.87 while the ledger
  -- held 408,809.59. A dropped function returns no row from this query, so it
  -- was never a false FAIL - just a name asking to be looked for.
  'increment_club_chip_pool',
  -- Rate limiting
  'check_rate_limit',
  -- Wallet logging
  'log_wallet_transaction'
)
ORDER BY proname;

-- 7. Confirm wallet_transactions has Realtime publication
SELECT
  'TEST_7_REALTIME_PUBLICATION' AS test,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND tablename = 'wallet_transactions'
    )
    THEN 'PASS'
    ELSE 'FAIL — wallet_transactions not in supabase_realtime publication'
  END AS result;

-- 8. Sanity: count of rows in collusion_tracking, rate_limits (operational tables exist)
SELECT 'TEST_8_OPERATIONAL_TABLES' AS test, 'collusion_tracking' AS table_name, COUNT(*) AS row_count FROM collusion_tracking
UNION ALL
SELECT 'TEST_8_OPERATIONAL_TABLES', 'rate_limits', COUNT(*) FROM rate_limits
UNION ALL
SELECT 'TEST_8_OPERATIONAL_TABLES', 'wallet_transactions', COUNT(*) FROM wallet_transactions
UNION ALL
SELECT 'TEST_8_OPERATIONAL_TABLES', 'rakeback_periods', COUNT(*) FROM rakeback_periods;

-- ═══════════════════════════════════════════════════════════════════════════════
-- EXPECTED RESULTS
-- ═══════════════════════════════════════════════════════════════════════════════
-- TEST 1 → PASS
-- TEST 2 → PASS
-- TEST 3 → 1+ rows, all per-user (qual contains auth.uid())
-- TEST 4 → PASS
-- TEST 5 → all 8 tables PASS
-- TEST 6 → all 8 functions PASS (SECURITY DEFINER)
-- TEST 7 → PASS
-- TEST 8 → row counts (informational only)
-- ═══════════════════════════════════════════════════════════════════════════════
