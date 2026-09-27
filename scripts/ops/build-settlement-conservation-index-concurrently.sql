-- One finite online operation through the maintained direct/session connection.
-- Confirm exact absent index, unchanged audit9502, owner and complete maintenance
-- runway first. Keep all platform DDL/freeze guards; statement_timeout=6min and
-- lock_timeout=180s allow normal preexisting transactions to complete.
-- Read durable outcome before any recovery; no blind CREATE retry or DROP.
-- The three possible text keys are bounded literals; included UUID/numeric20,4
-- values are bounded. No financial predicate, row, function or grant changes.
CREATE INDEX CONCURRENTLY idx_uwt_settlement_conservation
  ON public.union_wallet_transactions USING btree (tx_type, union_id, created_at)
  INCLUDE (club_id, amount)
  WHERE tx_type IN ('player_pnl_collect', 'player_pnl_pay', 'settlement_hold');
