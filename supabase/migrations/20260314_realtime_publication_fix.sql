-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION: Add ALL missing tables to supabase_realtime publication
-- ═══════════════════════════════════════════════════════════════════════════════
-- CRITICAL FIX: Many pages subscribe to postgres_changes on tables that are
-- NOT in the supabase_realtime publication. These subscriptions silently receive
-- zero events, making the UI appear as though realtime is broken.
--
-- This migration adds every table that any page subscribes to.
-- Uses IF NOT EXISTS checks to be idempotent and safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Helper function to safely add a table to the realtime publication
CREATE OR REPLACE FUNCTION _temp_add_to_realtime(tbl_name TEXT) RETURNS VOID AS $$
BEGIN
  -- Check table exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = tbl_name
  ) THEN
    RAISE NOTICE 'Table % does not exist, skipping', tbl_name;
    RETURN;
  END IF;

  -- Check not already in publication
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = tbl_name
  ) THEN
    RAISE NOTICE 'Table % already in supabase_realtime, skipping', tbl_name;
    RETURN;
  END IF;

  -- Add to publication
  EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', tbl_name);
  RAISE NOTICE 'Added % to supabase_realtime publication', tbl_name;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════════
-- CORE FINANCIAL TABLES (highest priority — CashierPage, WalletPage, etc.)
-- ═══════════════════════════════════════════════════════════════════════════════
SELECT _temp_add_to_realtime('wallets');
SELECT _temp_add_to_realtime('wallet_transactions');
SELECT _temp_add_to_realtime('table_chip_locks');
SELECT _temp_add_to_realtime('chip_transactions');
SELECT _temp_add_to_realtime('wallet_histories');
SELECT _temp_add_to_realtime('cashout_requests');
SELECT _temp_add_to_realtime('commission_ledger');
SELECT _temp_add_to_realtime('commission_rate_audit');

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLUB TABLES (ClubHomePage, ClubSettingsPage, ClubDetailPage, etc.)
-- ═══════════════════════════════════════════════════════════════════════════════
SELECT _temp_add_to_realtime('clubs');
SELECT _temp_add_to_realtime('club_announcements');
SELECT _temp_add_to_realtime('club_settlements');

-- ═══════════════════════════════════════════════════════════════════════════════
-- USER / PROFILE TABLES (ProfilePage, VIPPage, etc.)
-- ═══════════════════════════════════════════════════════════════════════════════
SELECT _temp_add_to_realtime('profiles');
SELECT _temp_add_to_realtime('friendships');
SELECT _temp_add_to_realtime('user_achievements');

-- ═══════════════════════════════════════════════════════════════════════════════
-- AGENT TABLES (AgentPortalPage, AgentManagementPage, etc.)
-- ═══════════════════════════════════════════════════════════════════════════════
SELECT _temp_add_to_realtime('agents');
SELECT _temp_add_to_realtime('agent_settlements');

-- ═══════════════════════════════════════════════════════════════════════════════
-- GAME / TABLE TABLES (BBJ, Flash Pools, Marketplace, etc.)
-- ═══════════════════════════════════════════════════════════════════════════════
SELECT _temp_add_to_realtime('bbj_pools');
SELECT _temp_add_to_realtime('bbj_winners');
SELECT _temp_add_to_realtime('flash_pools');
SELECT _temp_add_to_realtime('hand_history');
SELECT _temp_add_to_realtime('marketplace_items');
SELECT _temp_add_to_realtime('table_templates');
SELECT _temp_add_to_realtime('table_waitlists');

-- ═══════════════════════════════════════════════════════════════════════════════
-- SETTLEMENT / RAKE TABLES (SettlementPage, RakebackPage, etc.)
-- ═══════════════════════════════════════════════════════════════════════════════
SELECT _temp_add_to_realtime('settlement_periods');
SELECT _temp_add_to_realtime('rake_history');
SELECT _temp_add_to_realtime('rake_rate_audit');
SELECT _temp_add_to_realtime('rakeback_periods');

-- ═══════════════════════════════════════════════════════════════════════════════
-- PROMOTION / LEADERBOARD TABLES (PromotionsPage, LeaderboardPage, etc.)
-- ═══════════════════════════════════════════════════════════════════════════════
SELECT _temp_add_to_realtime('promotions');
SELECT _temp_add_to_realtime('promotion_leaderboards');
SELECT _temp_add_to_realtime('special_bonuses');

-- ═══════════════════════════════════════════════════════════════════════════════
-- UNION TABLES (UnionDetailPage, UnionsPage, etc.)
-- ═══════════════════════════════════════════════════════════════════════════════
SELECT _temp_add_to_realtime('unions');
SELECT _temp_add_to_realtime('union_admins');
SELECT _temp_add_to_realtime('union_applications');
SELECT _temp_add_to_realtime('union_clubs');
SELECT _temp_add_to_realtime('union_wallets');

-- ═══════════════════════════════════════════════════════════════════════════════
-- MODERATION / ADMIN TABLES (DisputeManagementPage, FinancialAlertsPage, etc.)
-- ═══════════════════════════════════════════════════════════════════════════════
SELECT _temp_add_to_realtime('disputes');
SELECT _temp_add_to_realtime('financial_alerts');
SELECT _temp_add_to_realtime('player_reports');

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLEANUP: Drop the temporary helper function
-- ═══════════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS _temp_add_to_realtime(TEXT);

-- ═══════════════════════════════════════════════════════════════════════════════
-- NOTE: This migration is idempotent. Tables that already exist in the
-- publication are safely skipped. Tables that don't exist yet are also skipped.
-- ═══════════════════════════════════════════════════════════════════════════════
