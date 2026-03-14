-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION: Enable Realtime on wallet_transactions
-- ═══════════════════════════════════════════════════════════════════════════════
-- wallet_transactions was created in 20260124100_player_wallets.sql but NEVER
-- added to the supabase_realtime publication. This means:
--   1. CashierPage's realtime wallet subscription silently receives NO events
--   2. RakebackDashboard's new realtime subscription also won't work
--   3. Any page subscribing to postgres_changes on wallet_transactions is broken
--
-- This migration adds wallet_transactions (and related financial tables) to the
-- supabase_realtime publication so all realtime subscriptions start working.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add wallet_transactions to realtime publication
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
    AND tablename = 'wallet_transactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.wallet_transactions;
    RAISE NOTICE 'Added wallet_transactions to supabase_realtime publication';
  END IF;
END $$;

-- Also add table_chip_locks (used by CashierPage for buy-in/cashout)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
    AND tablename = 'table_chip_locks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.table_chip_locks;
    RAISE NOTICE 'Added table_chip_locks to supabase_realtime publication';
  END IF;
END $$;

-- Also add chip_transactions if it exists (CashierPage subscribes to this)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'chip_transactions'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
      AND tablename = 'chip_transactions'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.chip_transactions;
      RAISE NOTICE 'Added chip_transactions to supabase_realtime publication';
    END IF;
  END IF;
END $$;

-- Also add wallet_histories if it exists (CashierPage subscribes to this)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'wallet_histories'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
      AND tablename = 'wallet_histories'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.wallet_histories;
      RAISE NOTICE 'Added wallet_histories to supabase_realtime publication';
    END IF;
  END IF;
END $$;

-- Enable RLS on wallet_transactions so realtime filters work correctly
-- (Supabase Realtime requires RLS to be enabled for row-level filtering)
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;

-- RLS policy: Users can see their own transactions via realtime
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'wallet_transactions'
    AND policyname = 'Users can view own wallet transactions'
  ) THEN
    CREATE POLICY "Users can view own wallet transactions"
      ON public.wallet_transactions
      FOR SELECT
      USING (auth.uid() = user_id);
    RAISE NOTICE 'Created RLS policy for wallet_transactions';
  END IF;
END $$;
