-- ═══════════════════════════════════════════════════════════════════════════
--  PROVING A PLAYED SPIN LAUNCH READS 1.8 GB OF LEDGER TO FIND TWO ROWS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS (2026-09-16)
--
-- `fn_prove_played_spin_launch_recovery`, from pg_stat_statements:
--
--     calls          254
--     mean         3,109 ms
--     max          9,885 ms      (its own 10 s statement_timeout)
--
-- and in the engine log, from the door that asks it:
--
--     [Tournament.played_spin_recovery_unreadable] Played Spin recovery proof
--     was unreadable (canceling statement due to statement timeout)
--
-- A proof that cannot be read is a Spin that stands down instead of dealing:
-- this is the function behind the forty REGISTERING Spins stranded with paid
-- seats on 2026-09-12 (2,574.12 of buy-ins), and it is still timing out today.
--
-- ── WHERE THE THREE SECONDS GO ────────────────────────────────────────────
--
-- The `journals` CTE asks for this Spin's two ledger rows:
--
--     FROM public.chip_ledger l
--      WHERE l.tournament_id = p_tournament_id
--        AND l.category IN ('spin_entry', 'spin_prize')
--
-- EXPLAIN (ANALYZE, BUFFERS) on production for one RUNNING Spin:
--
--     Parallel Seq Scan on chip_ledger l  (actual rows=0 loops=5)
--       Filter: (category = ANY ('{spin_entry,spin_prize}') AND tournament_id = ...)
--       Rows Removed by Filter: 809372
--       Buffers: shared hit=238660
--     Execution Time: 995.928 ms
--
-- Four workers and 238,660 buffers (1.8 GB) to return two rows, because the
-- only indexes on `tournament_id` are partial ones for `overlay` and `rebuy`.
-- One second when every block is cached and the box is quiet; three to ten
-- under the load a Spin launch storm creates, which is exactly when the
-- recovery door is asked.
--
-- ── THE INDEX ─────────────────────────────────────────────────────────────
--
-- (tournament_id, category), partial on `tournament_id IS NOT NULL`: 625,543 of
-- 4,046,878 rows carry a tournament, so the index is a fifteenth of the table
-- and answers every per-event ledger read by category, this proof's first.
-- Twenty-eight functions filter `chip_ledger` by a tournament id; the ones on
-- hot paths already have narrower partial indexes and keep using them.
--
-- CONCURRENTLY, because `chip_ledger` is the money ledger of a live platform,
-- and `statement_timeout = 0` for the same reason every other concurrent index
-- in this directory sets it. Nothing about the function changes.

SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_tournament_category
  ON public.chip_ledger (tournament_id, category)
  WHERE tournament_id IS NOT NULL;
