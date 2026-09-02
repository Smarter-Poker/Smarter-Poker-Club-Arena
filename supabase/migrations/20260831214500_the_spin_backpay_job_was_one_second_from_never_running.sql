-- ═══════════════════════════════════════════════════════════════════════════
--  THE SPIN BACK-PAY JOB WAS ONE SECOND FROM NEVER RUNNING (2026-08-31)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Found while making fn_spin_metrics fit inside a scrape, not while looking
-- for it.
--
-- `v_spin_unpaid_settlements` compares what the reserve pool DREW for each
-- Spin against what reached a player's wallet. It is the safety net under the
-- one failure where a prize leaves the bank and lands nowhere, and 52 events
-- had already diverged when it was built. It measures **10.5 seconds**: it
-- groups the entire spin_reserve_ledger and every prize credit in
-- wallet_transactions (2.5M rows, 979 MB) before filtering down to a handful.
--
-- `fn_backpay_spin_unpaid_winners` reads that view, and GameServer calls it
-- every ten minutes. The service_role statement timeout is **8 seconds**.
-- Measured end to end through PostgREST, exactly as the engine calls it:
--
--     http=200 total=8.181050s
--
-- The money repair was 0.2 s from failing, permanently and silently, the
-- first time the database was busier than it was that afternoon. Nothing
-- would have reported it: the RPC returns an error the caller logs, and a
-- back-pay that never finds anything and a back-pay that never runs look
-- identical from outside.
--
-- Two covering indexes. The prize-credit one is the whole cost: the planner
-- was reaching that data through an index keyed on (user_id, created_at) and
-- discarding 267,000 rows per worker to keep 32,000.
--
-- CONCURRENTLY, because wallet_transactions is the shared money receipt
-- table and this must not block a single buy-in. This migration must NOT be
-- wrapped in an explicit transaction.

SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_tx_prize_credits_by_entity
  ON public.wallet_transactions (related_entity_id)
  INCLUDE (amount)
  WHERE type = 'credit' AND category = 'prize' AND related_entity_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_spin_reserve_ledger_draws
  ON public.spin_reserve_ledger (tournament_id)
  INCLUDE (amount, created_at)
  WHERE kind = 'jackpot_draw' AND tournament_id IS NOT NULL;

COMMENT ON INDEX public.idx_wallet_tx_prize_credits_by_entity IS
  'Per-tournament prize-credit totals without scanning 2.5M wallet rows. v_spin_unpaid_settlements measured 10.5s without it, and fn_backpay_spin_unpaid_winners - a money repair the engine runs every 10 minutes under an 8s statement timeout - measured 8.18s end to end. It was 0.2s from silently never running again.';

COMMENT ON INDEX public.idx_spin_reserve_ledger_draws IS
  'Covering index for jackpot_draw totals per spin; turns the ledger seq scan in v_spin_unpaid_settlements and v_spin_draw_booking_gaps into an index-only scan.';

-- ROLLBACK (online):
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_wallet_tx_prize_credits_by_entity;
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_spin_reserve_ledger_draws;
