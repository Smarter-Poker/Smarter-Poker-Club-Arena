-- ═══════════════════════════════════════════════════════════════════════════
-- CONSOLIDATED MIGRATION: Run this in Supabase SQL Editor
-- Date: 2026-03-14
-- ═══════════════════════════════════════════════════════════════════════════

-- PART 1: Add tables to supabase_realtime publication
-- (Idempotent — safe to re-run)
CREATE OR REPLACE FUNCTION _temp_add_to_realtime(tbl_name TEXT) RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = tbl_name) THEN
    RAISE NOTICE 'Table % does not exist, skipping', tbl_name;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = tbl_name) THEN
    RAISE NOTICE 'Table % already in supabase_realtime, skipping', tbl_name;
    RETURN;
  END IF;
  EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', tbl_name);
  RAISE NOTICE 'Added % to supabase_realtime publication', tbl_name;
END;
$$ LANGUAGE plpgsql;

-- Financial tables
SELECT _temp_add_to_realtime('wallets');
SELECT _temp_add_to_realtime('wallet_transactions');
SELECT _temp_add_to_realtime('table_chip_locks');
SELECT _temp_add_to_realtime('chip_transactions');
SELECT _temp_add_to_realtime('wallet_histories');
SELECT _temp_add_to_realtime('cashout_requests');
SELECT _temp_add_to_realtime('commission_ledger');
SELECT _temp_add_to_realtime('commission_rate_audit');

-- Club tables
SELECT _temp_add_to_realtime('clubs');
SELECT _temp_add_to_realtime('club_announcements');
SELECT _temp_add_to_realtime('club_settlements');

-- User/profile tables
SELECT _temp_add_to_realtime('profiles');
SELECT _temp_add_to_realtime('friendships');
SELECT _temp_add_to_realtime('user_achievements');

-- Agent tables
SELECT _temp_add_to_realtime('agents');
SELECT _temp_add_to_realtime('agent_settlements');

-- Game/table tables
SELECT _temp_add_to_realtime('bbj_pools');
SELECT _temp_add_to_realtime('bbj_winners');
SELECT _temp_add_to_realtime('flash_pools');
SELECT _temp_add_to_realtime('hand_history');
SELECT _temp_add_to_realtime('marketplace_items');
SELECT _temp_add_to_realtime('table_templates');
SELECT _temp_add_to_realtime('table_waitlists');

-- Settlement/rake tables
SELECT _temp_add_to_realtime('settlement_periods');
SELECT _temp_add_to_realtime('rake_history');
SELECT _temp_add_to_realtime('rake_rate_audit');
SELECT _temp_add_to_realtime('rakeback_periods');

-- Promotion/leaderboard tables
SELECT _temp_add_to_realtime('promotions');
SELECT _temp_add_to_realtime('promotion_leaderboards');
SELECT _temp_add_to_realtime('special_bonuses');

-- Union tables
SELECT _temp_add_to_realtime('unions');
SELECT _temp_add_to_realtime('union_admins');
SELECT _temp_add_to_realtime('union_applications');
SELECT _temp_add_to_realtime('union_clubs');
SELECT _temp_add_to_realtime('union_wallets');

-- Moderation/admin tables
SELECT _temp_add_to_realtime('disputes');
SELECT _temp_add_to_realtime('financial_alerts');
SELECT _temp_add_to_realtime('player_reports');

-- Cleanup helper function
DROP FUNCTION IF EXISTS _temp_add_to_realtime(TEXT);

-- PART 2: Enable RLS on wallet_transactions (if not already)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'wallet_transactions' AND rowsecurity = true) THEN
    ALTER TABLE IF EXISTS wallet_transactions ENABLE ROW LEVEL SECURITY;
    RAISE NOTICE 'Enabled RLS on wallet_transactions';
  END IF;
END $$;

-- Add user-scoped SELECT policy if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'wallet_transactions' AND policyname = 'wallet_transactions_select_own') THEN
    CREATE POLICY wallet_transactions_select_own ON wallet_transactions FOR SELECT USING (auth.uid() = user_id);
    RAISE NOTICE 'Created SELECT policy on wallet_transactions';
  END IF;
END $$;

-- Verify: Show all tables now in supabase_realtime
SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime' ORDER BY tablename;
