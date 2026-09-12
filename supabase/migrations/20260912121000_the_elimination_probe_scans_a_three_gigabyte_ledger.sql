-- ═══════════════════════════════════════════════════════════════════════════
--  ELIMINATING ONE PLAYER READS 3 GB OF LEDGER TO ANSWER "DID THEY REBUY"
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS (2026-09-12)
--
-- `fn_eliminate_tournament_player_atomic`, from pg_stat_statements:
--
--     calls        45,639
--     mean          2,290.6 ms
--     max           7,968.0 ms
--     total        104,541.9 s      (29 hours of database time)
--
-- Two point three seconds to bust one player, and a worst case of eight, which
-- is the statement timeout. The engine log shows what that costs:
--
--     [Tournament.elimination_write_failed] atomic elimination FAILED for
--     2d6c5e7a at place 395 after exact transport replay:
--     canceling statement due to statement timeout
--
-- The function takes `FOR UPDATE` on the tournament row, so eliminations in one
-- event are strictly serial. At 2.3 s each, a field busting in bursts queues
-- until the ones at the back hit the timeout and are never eliminated at all.
-- They stay `status='playing'` at zero chips, the event can never count down to
-- one player, and it hangs with its prize pool unpaid.
--
-- Measured the same day: 30 MTTs RUNNING for over six hours, the oldest three
-- days and six hours, holding 15,570.00 of buy-ins across 1,485 players, of
-- whom 1,397 hold zero chips and have simply never been eliminated. Small
-- fields finish normally; the failures are at place 395.
--
-- ── WHERE THE 2.3 SECONDS GOES ────────────────────────────────────────────
--
-- The rebuy check. EXPLAIN (ANALYZE, BUFFERS) on production, one probe:
--
--     Index Scan using idx_chip_ledger_from_entity_created on chip_ledger l
--       (actual time=429.626..429.626 rows=0 loops=1)
--       Index Cond: (from_entity_id = ...)
--       Filter: (amount > 0 AND tournament_id = ... AND category = 'rebuy'
--                AND from_type = 'player_wallet' AND to_type = 'prize_liability'
--                AND status = 'posted')
--       Rows Removed by Filter: 644
--       Buffers: shared hit=317 read=333
--     Execution Time: 429.771 ms
--
-- 429 ms, to return nothing. The only usable index is
-- `(from_entity_id, created_at DESC)`, so Postgres walks every ledger row that
-- player ever wrote and discards all 644 in the heap, reading 333 blocks off
-- disk to do it. `chip_ledger` is 3.5 million rows and 3,050 MB.
--
-- That probe sits inside a correlated EXISTS that runs per knockout candidate,
-- so a handful of them is the whole 2.3 s mean.
--
-- ── THE INDEX ─────────────────────────────────────────────────────────────
--
-- Partial, on exactly the four constants the probe fixes. `category = 'rebuy'`
-- is 14,468 rows of 3,506,751 - 0.41% of the table - so this is a small index
-- and a negligible write cost on the money path, and the probe becomes a direct
-- lookup instead of a walk.
--
-- `created_at` is the third column because the probe also bounds the row to a
-- window between two knockout candidates, so the range is answered from the
-- index rather than the heap.
--
-- CONCURRENTLY, because `chip_ledger` is the money ledger of a live platform
-- and a plain CREATE INDEX would hold a write lock over a 3 GB table while it
-- builds. `statement_timeout = 0` for the same reason every other concurrent
-- index in this directory sets it.
--
-- Nothing about the function changes. This is the same question, asked of an
-- index that can answer it.

SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_rebuy_probe
  ON public.chip_ledger (from_entity_id, tournament_id, created_at)
  WHERE category = 'rebuy'
    AND from_type = 'player_wallet'
    AND to_type = 'prize_liability'
    AND status = 'posted';
