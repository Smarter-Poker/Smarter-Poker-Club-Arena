-- The Players ledger has one additional high-volume branch that the Games
-- ledger does not: cash buy-in/cash-out net by attributed union member.  Its
-- previous all-category index required heap reads across the wallet ledger and
-- left the complete player RPC above the authenticated 8 second budget.

CREATE INDEX IF NOT EXISTS idx_wallet_tx_club_data_cash_user_window
  ON public.wallet_transactions (user_id, created_at)
  INCLUDE (type, amount, table_id)
  WHERE category IN ('buyin', 'cashout')
    AND table_id IS NOT NULL;
