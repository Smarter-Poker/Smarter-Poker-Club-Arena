-- Four finite online index builds for the hourly conservation sweep's
-- unbounded reads, through the maintained direct/session connection, OUTSIDE
-- any transaction block and outside the :50-:03 break window. Each statement
-- is one CREATE INDEX CONCURRENTLY; run them in order, one at a time, with
-- statement_timeout=10min and lock_timeout=180s. Confirm each index is absent
-- first; after an unknown outcome read pg_index (indisvalid/indisready) for
-- that exact name before anything else. No blind retry, no DROP here.
-- Then install 20261001152917, which only verifies what was built.
--
-- 1. fn_chip_drift_since_baseline (fn_chip_integrity_report, first sweep check):
--    every player_wallet leg since the 2026-08-26 baseline, read by an index
--    scan on created_at that visits the heap for each of ~6.2M rows.
CREATE INDEX CONCURRENTLY idx_chip_ledger_player_wallet_drift
  ON public.chip_ledger USING btree (created_at)
  INCLUDE (club_id, to_type, to_entity_id, from_type, from_entity_id, amount)
  WHERE club_id IS NOT NULL AND (to_type = 'player_wallet' OR from_type = 'player_wallet');

-- 2. fn_bbj_conservation_check's epoch identity: every bbj_pool leg since the
--    epoch opened, ~2.5M of ~4.9M rows, same heap-per-row pattern.
CREATE INDEX CONCURRENTLY idx_chip_ledger_bbj_pool_epoch
  ON public.chip_ledger USING btree (created_at)
  INCLUDE (to_type, from_type, amount)
  WHERE to_type = 'bbj_pool' OR from_type = 'bbj_pool';

-- 3. fn_ca_payout_rows_without_money: a 3-day window read by a sequential scan
--    of every tournament_payouts row.
CREATE INDEX CONCURRENTLY idx_tournament_payouts_paid_at
  ON public.tournament_payouts USING btree (paid_at);

-- 4. The same check's min(created_at) of wallet_credit_idempotency, a
--    sequential scan of the whole table on every run.
CREATE INDEX CONCURRENTLY idx_wallet_credit_idempotency_created_at
  ON public.wallet_credit_idempotency USING btree (created_at);
