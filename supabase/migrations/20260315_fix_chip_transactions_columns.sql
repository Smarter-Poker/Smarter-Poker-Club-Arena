-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX BUG #38: Add missing cashout escrow columns to chip_transactions
-- ═══════════════════════════════════════════════════════════════════════════════
-- CashoutService writes reversible_until and is_reversed but they don't exist
-- on the live DB. The removal reversal system is completely broken without them.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add the missing columns
ALTER TABLE chip_transactions ADD COLUMN IF NOT EXISTS reversible_until TIMESTAMPTZ;
ALTER TABLE chip_transactions ADD COLUMN IF NOT EXISTS is_reversed BOOLEAN DEFAULT FALSE;

-- Create index for efficient reversal lookups
CREATE INDEX IF NOT EXISTS idx_chip_transactions_reversible
  ON chip_transactions(reversible_until)
  WHERE reversible_until IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chip_transactions_reversed
  ON chip_transactions(is_reversed)
  WHERE is_reversed = FALSE;
