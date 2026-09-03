-- 20260823065000_covering_index_for_weekly_rake_sums.sql
--
-- fn_club_money_panel was the second most expensive statement on the instance:
-- 168 calls at a mean of 1,483.8 ms over a 30-minute window. It is CLIENT
-- FACING - the club money panel - so that is a page that takes a second and a
-- half to answer.
--
-- Its cost is two weekly aggregates over union_wallet_transactions, which the
-- engine appends to on every raked hand. The existing partial index
-- idx_uwt_rake_credit_basis (union_id, created_at) matched the predicate but
-- does not carry `amount`, so every one of ~330,000 rows in the current week
-- required a heap visit:
--
--   Parallel Index Scan idx_uwt_rake_credit_basis
--   rows=330,476  Buffers: shared hit=287,862  Execution: 331 ms
--
-- This index INCLUDEs amount and club_id, which covers BOTH aggregates in the
-- function: the union-wide sum and the per-club sum (club_id is the only other
-- column either of them touches).
--
-- Measured after this index plus the first-ever VACUUM of the table
-- (20260823070000 / 20260823080000 keep the visibility map set from here on):
--
--   Parallel Index Only Scan idx_uwt_rake_credit_sum
--   Heap Fetches: 226,432 -> 2,117
--   Buffers:      189,415 -> 3,274      (58x fewer)
--   Execution:        331 ms -> 103 ms
--
-- NOTE ON HOW THIS WAS APPLIED. On production this index was built with
-- CREATE INDEX CONCURRENTLY, because a plain CREATE INDEX takes a ShareLock and
-- would have blocked the engine's rake writes mid-hand on a 698,820-row table.
-- CONCURRENTLY cannot run inside a transaction and Supabase migrations do, so
-- this file is written to be a no-op where the index already exists and to
-- build it normally in a fresh environment (where there is no traffic to block).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.relname = 'idx_uwt_rake_credit_sum'
       AND c.relnamespace = 'public'::regnamespace
  ) THEN
    CREATE INDEX idx_uwt_rake_credit_sum
      ON public.union_wallet_transactions (union_id, created_at)
      INCLUDE (amount, club_id)
      WHERE (wallet = 'rake_wallet' AND direction = 'credit' AND tx_type = 'rake');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = 'public.idx_uwt_rake_credit_sum'::regclass
       AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'idx_uwt_rake_credit_sum is missing or invalid';
  END IF;
END $$;

-- STILL OPEN, deliberately not done here: this sum walks the whole week and the
-- week only grows - ~330k rows by Saturday and rising. A covering index makes
-- each row cheap; it does not stop there being more of them every day. The
-- durable fix is an incrementally maintained weekly rollup, which is a change
-- to financial aggregation and wants its own review rather than being bolted on
-- during an incident.

-- ROLLBACK
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_uwt_rake_credit_sum;
