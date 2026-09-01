-- The second scheduled check this week that was scanning hand_history whole.
--
-- fn_ca_settlement_correctness_check() runs every 30 minutes. Its legacy-
-- fallback alarm asks two questions of hand_history:
--
--   SELECT count(*) FROM public.hand_history
--    WHERE created_at > now() - interval '24 hours' AND has_human IS TRUE;
--
-- and the same shape again over the last hour. Only idx_hand_history_created
-- (bare created_at) could serve them, so each run counted its way through
-- every hand dealt in 24 hours -- roughly 213,000 rows -- to find the ones with
-- a human at the table.
--
-- There are 22 of them. Human hands are 0.01% of the board; the other 99.99%
-- of the scan is horses, read and discarded twice per run.
--
-- The job averaged 66s against a 120s statement timeout and had already hit it
-- (2026-09-01 02:30). That is the same trajectory rake-repair-unbanked-hourly
-- was on before 20260901104500, and the same fix applies: give the predicate
-- its own index instead of asking the planner to filter a full window.
--
-- Measured on production:
--   count(*) alone   >60s (client timeout) -> 1,354ms warm
--   the whole check   66s average, 120s worst -> 5,383ms
--
-- CONCURRENTLY keeps hand_history writable while the index builds. This
-- migration must not be wrapped in an explicit transaction.

SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hand_history_human_created
  ON public.hand_history (created_at)
  WHERE has_human;

COMMENT ON INDEX public.idx_hand_history_human_created IS
  'Bounds the human-hand coverage counts in fn_ca_settlement_correctness_check. Human hands are ~0.01% of hand_history; without this the 30-minute job counted the whole 24h window twice per run and hit the 120s timeout.';

-- ROLLBACK (online):
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_hand_history_human_created;
