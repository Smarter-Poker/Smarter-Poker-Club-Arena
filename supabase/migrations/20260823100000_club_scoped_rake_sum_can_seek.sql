-- 20260823100000_club_scoped_rake_sum_can_seek.sql
--
-- fn_club_money_panel is the most expensive statement on the instance by 3.7x:
-- 1,238 calls at a mean of 1,454 ms (min 110, max 3,396), 1,785 seconds total.
--
-- It runs TWO weekly sums over union_wallet_transactions. 20260823065000 gave
-- the union-wide one a covering index. The CLUB-scoped one could not use it as a
-- seek, because club_id sat in INCLUDE rather than in the key, so it scanned the
-- entire union range and discarded most of it:
--
--   Parallel Index Only Scan idx_uwt_rake_credit_sum
--   Filter: (club_id = ...)   Rows Removed by Filter: 77,188
--   Buffers: shared hit=18,531   Execution: 131 ms
--
-- With club_id promoted to a key column the scan becomes a true seek - no
-- filter, nothing discarded:
--
--   Parallel Index Only Scan idx_uwt_rake_credit_club_sum
--   Index Cond: (union_id = ... AND club_id = ... AND created_at >= ...)
--   Buffers: shared hit=14,513
--
-- HONEST LIMIT OF THIS FIX. It removes the wasted 77,188-row filter, but the
-- club genuinely has 178,920 rake rows in the current week, and the sum still
-- has to add all of them - so execution stays around 130-150 ms and grows every
-- day until the week rolls over. No index can fix that; the work is real.
--
-- THE ACTUAL FIX IS A ROLLUP, AND IT IS DELIBERATELY NOT DONE HERE. There is no
-- existing rake-AMOUNT rollup to write into: union_rake_rollup_days holds only
-- (union_id, day, records_seen, computed_at) - a completion marker, no money -
-- and club_rake_rollup_complete is the same shape. A weekly amount rollup would
-- therefore be NEW financial infrastructure, which RULE 12 says to raise rather
-- than create, and money aggregation deserves review rather than being added
-- during an incident. Flagged for Dan with the numbers above.
--
-- Built with CREATE INDEX CONCURRENTLY on production so it never took a
-- ShareLock against the engine's rake writes. CONCURRENTLY cannot run inside a
-- transaction and Supabase migrations do, so this file is a no-op where the
-- index exists and builds it normally in a fresh environment.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.relname = 'idx_uwt_rake_credit_club_sum'
       AND c.relnamespace = 'public'::regnamespace
  ) THEN
    CREATE INDEX idx_uwt_rake_credit_club_sum
      ON public.union_wallet_transactions (union_id, club_id, created_at)
      INCLUDE (amount)
      WHERE (wallet = 'rake_wallet' AND direction = 'credit' AND tx_type = 'rake');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = 'public.idx_uwt_rake_credit_club_sum'::regclass
       AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'idx_uwt_rake_credit_club_sum is missing or invalid';
  END IF;
END $$;

-- ROLLBACK
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_uwt_rake_credit_club_sum;
