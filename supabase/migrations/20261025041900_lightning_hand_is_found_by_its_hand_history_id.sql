-- 20261025041900_lightning_hand_is_found_by_its_hand_history_id.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch. This file adds ONE index and changes nothing else: no
-- function body, grant, row, chip or schedule.
--
-- WHY (measured 2026-10-25 04:10 UTC)
--
-- fn_cash_earning_club (called by atomic_distribute_rake for every attributed
-- player of every cash hand) asks first whether the hand is a pooled Lightning
-- hand:
--   EXISTS(SELECT 1 FROM public.lightning_hand h
--           WHERE h.hand_history_id=p_hand_id AND h.host_table_id=p_table_id)
-- and, when it is, joins lightning_hand on the same predicate again. No index
-- of lightning_hand leads with hand_history_id (its keys are hand_id,
-- (hand_id,cluster_id,cluster_epoch), (cluster_id,cluster_epoch,formed_at),
-- (formed_at,cluster_id), lightning_instance_id, hand_number, request_id), so
-- every probe is a parallel sequential scan: EXPLAIN ANALYZE of that exact
-- EXISTS read 55,580 buffers and took 230 ms at 291,641 rows (434 MB heap,
-- 6,202 rows written in the last hour, growing). It runs inside the hand's
-- rake transaction, per player, for Classic and Lightning hands alike - a
-- Classic hand pays the full scan to learn the answer is no.
--
-- The column is uuid, 289,756 distinct values over 291,641 rows (1,885 NULL),
-- so a plain btree on (hand_history_id) answers the probe in a few buffers.
--
-- HOW
--
-- lightning_hand is written on every Lightning hand, so a plain CREATE INDEX
-- would hold SHARE on it for the whole build and stall the pool. It is built
-- CONCURRENTLY in the preamble that scripts/ci/migration-concurrent-preamble.mjs
-- admits (IF NOT EXISTS, before the one transaction), and the transaction then
-- refuses an interrupted (invalid) or differently shaped leftover by name.
--
-- Install: the ordinary applier outside the :50-:03 break window. The
-- concurrent build waits for transactions already touching lightning_hand and
-- takes no lock that blocks its writers. If it is interrupted, the guard below
-- refuses the INVALID index; drop it (DROP INDEX CONCURRENTLY) and apply again.
--
-- Pinned by tests/lightning-hand-is-found-by-its-hand-history-id.law.test.ts.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lightning_hand_hand_history_id
 ON public.lightning_hand (hand_history_id);

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- IF NOT EXISTS is not evidence that an existing index has the right shape or
-- finished its concurrent build: refuse an interrupted or unrelated one.
DO $index_guard$
DECLARE v_def text; v_valid boolean; v_ready boolean;
BEGIN
  SELECT pg_get_indexdef(i.indexrelid), i.indisvalid, i.indisready
    INTO v_def, v_valid, v_ready
    FROM pg_index i
   WHERE i.indexrelid = to_regclass('public.idx_lightning_hand_hand_history_id')
     AND i.indrelid = 'public.lightning_hand'::regclass;
  IF v_valid IS DISTINCT FROM true OR v_ready IS DISTINCT FROM true
     OR v_def IS DISTINCT FROM
        'CREATE INDEX idx_lightning_hand_hand_history_id ON public.lightning_hand USING btree (hand_history_id)' THEN
    RAISE EXCEPTION 'idx_lightning_hand_hand_history_id is missing, invalid or not the expected shape: %', v_def;
  END IF;
END $index_guard$;

COMMIT;
