-- THE PAYABLES READ STOPS WALKING 88MB OF HEAP.
--
-- fn_ca_agent_payables, applied minutes ago in 20260903200000, answers
-- correctly and answered slowly the first time it was asked:
--
--   cold   5,198 ms
--   warm     445 ms
--
-- The plan says why. The aggregate rides agent_commissions_unsettled_idx,
-- which is (club_id, user_id) WHERE settled_at IS NULL - so the index finds
-- the club's 259,257 rows in 375 buffers, and then the heap is visited for
-- `amount` and `created_at`:
--
--   Parallel Bitmap Heap Scan on agent_commissions
--     Heap Blocks: exact=3313        Buffers: shared hit=11248
--   Execution Time: 150.963 ms   (warm, everything already in cache)
--
-- 11,248 buffers is about 88MB. Warm that is 151ms; cold it is five seconds
-- of disk, which is what an operator opening the payouts tab actually gets.
--
-- The two columns the aggregate needs are small and never change after the
-- row is written, so they belong in the index. This makes the scan index-only
-- for this query: the club's slice goes from ~88MB of heap to a few MB of
-- index.
--
-- WHAT THIS COSTS. The existing partial index is 22MB across 2,054,257
-- unsettled rows; carrying `amount` and `created_at` roughly doubles that.
-- Worth naming: 2,054,257 of the table's rows are unsettled - nothing on this
-- estate has ever been marked settled - so `settled_at IS NULL` is not a
-- selective predicate today. It is kept because it is the correct predicate
-- for the question, and it will start doing real work the first time a
-- settlement run marks a period paid.
--
-- The build takes a ShareLock on agent_commissions, so commission inserts
-- queue behind it for the few seconds it runs rather than failing. It is not
-- CONCURRENTLY because this estate's rule is one migration, one transaction,
-- and CREATE INDEX CONCURRENTLY cannot run inside one. On a 2M-row table that
-- trade is the right way round.
--
-- The old index is dropped in the same transaction: a covering index answers
-- everything the narrower one did, and leaving both would pay for two.

DROP INDEX IF EXISTS public.agent_commissions_unsettled_idx;

CREATE INDEX agent_commissions_unsettled_idx
    ON public.agent_commissions (club_id, user_id)
 INCLUDE (amount, created_at)
   WHERE settled_at IS NULL;

ANALYZE public.agent_commissions;
