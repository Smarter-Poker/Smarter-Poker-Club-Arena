-- ═══════════════════════════════════════════════════════════════════════════
--  THE THAW STOPS READING EVERY TOURNAMENT EVER PLAYED
--  2026-09-02 - applied live at 19:47 UTC (CREATE INDEX CONCURRENTLY, so it
--  blocked no writer); this file is the record, and is idempotent.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_thaw_platform has never once succeeded on production. The 18:55 break
-- logged:
--
--   [MaintenanceBreak] THAW FAILED - resuming anyway; clocks lost the frozen
--   minutes. Error: canceling statement due to statement timeout
--
-- The engine calls the thaw through PostgREST as service_role, whose
-- statement_timeout is 8s, and the function was measured at 19.9s on the same
-- path (rolled back). Three of its eight UPDATEs carried no usable index, so
-- each one read its whole table to find a handful of rows:
--
--   tournaments        WHERE addon_period_ends_at > freeze   seq scan 124 MB  2.6s  ->  0 rows
--   chip_transactions  WHERE reversible_until     > freeze   seq scan 348 MB  1.5s  ->  3 rows
--   tables             WHERE bomb_pot_next_due_at IS NOT NULL seq scan  79 MB  1.2s  -> 25 rows
--
-- A partial index on each makes those three lookups cost nothing. Measured
-- afterwards, again as service_role and rolled back: 6.6s cold, 3.1s warm.
-- That is inside the budget but not comfortably; the remaining cost is the
-- trigger chain on the tournaments level-clock UPDATE (~32ms a row, seven
-- unconditional UPDATE triggers), which is a separate change with its own
-- review. This one is only the indexes.
--
-- A function-level SET statement_timeout would NOT have helped: the timer is
-- armed when the outer statement starts, and a SET inside the function does
-- not re-arm it (proved with pg_temp function + pg_sleep on 2026-09-02, and
-- measured on the RPC path by GtoAggregationDriver on 2026-08-29).

CREATE INDEX IF NOT EXISTS idx_tournaments_addon_period_open
  ON public.tournaments (addon_period_ends_at)
  WHERE addon_period_ends_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tables_bomb_pot_due
  ON public.tables (bomb_pot_next_due_at)
  WHERE bomb_pot_next_due_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chip_transactions_reversible_open
  ON public.chip_transactions (reversible_until)
  WHERE reversible_until IS NOT NULL;
