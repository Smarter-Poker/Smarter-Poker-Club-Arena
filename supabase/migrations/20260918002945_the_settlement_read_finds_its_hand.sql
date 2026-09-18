-- 20260918002945_the_settlement_read_finds_its_hand.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE SETTLEMENT READ FINDS ITS HAND
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS (2026-09-18, found while diagnosing a fleet collapse)
--
-- Between 00:15 and 00:27 UTC the database cancelled 3,160 statements at the
-- eight-second timeout. 3,048 of them - 96 percent - were one query:
--
--   SELECT to_jsonb(c) FROM public.ca_settlements c
--    WHERE c.table_id = p_table AND c.hand_id = v_stack_hand
--      AND c.settlement_type = 'hand_stacks' AND c.state = 'final'
--
-- inside fn_cash_accept_hand_provenance, which every dealt cash hand calls,
-- and inside fn_pnl_cash_hand_evidence. public.ca_settlements holds 7,894,851
-- rows in 6,657 MB, of which 7,783,150 are hand_stacks/final, and its only
-- indexes are the primary key, (settlement_type, external_ref) and two on
-- updated_at. Nothing indexes the table or the hand, so the planner had one
-- option. EXPLAIN (ANALYZE, BUFFERS) on production, 00:33 UTC:
--
--   Gather (actual time=7511..9670 rows=0)
--     Workers Planned: 4, Launched: 4
--     Buffers: shared hit=484321
--     ->  Parallel Seq Scan on ca_settlements c (actual time=7387 rows=0, loops=5)
--
-- 9.7 seconds and 3.8 GB of shared buffers, on five backends, to find at most
-- one row - about 250 times a minute. The engine's own calls time out at eight
-- seconds, so the reads that caused the load were themselves cancelled and
-- retried. At 00:20:04 the engine began reporting supabase_timeout across
-- unrelated paths, tournament leases expired, watchdogs self-terminated their
-- engines, and the fleet fell from 1,478 active tables and 2,326 seated horses
-- to 230 and 274 in six minutes.
--
-- The index below is the whole fix: the predicate's two leading columns, which
-- reduce the scan to a handful of rows. settlement_type and state are not in
-- it because they are not selective here - 98.6 percent of the table is
-- hand_stacks/final - and a two-column btree is enough to make the lookup a
-- point read.
--
-- CONCURRENTLY, and therefore no BEGIN/COMMIT: ca_settlements takes a write
-- on every settled hand, and a plain CREATE INDEX would hold a SHARE lock on
-- 6.6 GB while it built. CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block, so this file follows the 59 earlier migrations of the
-- same shape (for example 20260917173357) and is applied with psql, then
-- recorded in supabase_migrations.schema_migrations under this version and
-- name.
--
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS public.idx_ca_settlements_table_hand;

SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ca_settlements_table_hand
  ON public.ca_settlements (table_id, hand_id);

COMMENT ON INDEX public.idx_ca_settlements_table_hand IS
  'fn_cash_accept_hand_provenance and fn_pnl_cash_hand_evidence read one settlement by (table_id, hand_id). Without this the planner had a parallel sequential scan of 6.6 GB: 9.7 s and 484,321 buffers per call, 3,048 statement timeouts in twelve minutes on 2026-09-18, and a fleet collapse behind them.';
