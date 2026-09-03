-- The hourly cash-rake healer was timing out on a search that finds nothing.
--
-- rake-repair-unbanked-hourly calls fn_rake_repair_unbanked(48, 200), whose
-- candidate query looks for cash hands that banked rake but never got a
-- rake_records row. There are none: the query returned ZERO candidates every
-- time it was measured. It still cost 56s, 64s, 80s, 95s, 116s on consecutive
-- runs -- climbing with the table -- and died at the 120s statement timeout on
-- 4 of the last 24 runs, most recently 2026-08-31 23:52.
--
-- A healer that cannot finish is worse than no healer: it burns two minutes of
-- database every hour, reports failure, and would not have banked the rake if
-- there had been any to bank.
--
-- The cost was the scan. hand_history carries 426,168 rows in a 48h window and
-- only 40,472 of them are cash hands with rake -- but the only usable index was
-- idx_hand_history_created (created_at DESC, no predicate), so every run walked
-- all 426k. The one partial index that mentions tournament_id,
-- idx_hand_history_tournament_created, is WHERE tournament_id IS NOT NULL --
-- exactly the opposite population.
--
-- This index matches the job's predicate, so the scan drops about 10x. The
-- three NOT EXISTS probes were already indexed (uq_rake_records_hand_id,
-- idx_rake_records_relink, uq_pending_fee_open_hand_kind).
--
-- Measured on production, same call, before and after: 116,000ms -> 9,768ms.
--
-- CONCURRENTLY keeps hand_history writable while the index builds -- it takes
-- roughly 600 hands a minute during play. This migration must not be wrapped in
-- an explicit transaction.

SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hand_history_cash_rake_unbanked
  ON public.hand_history (created_at)
  WHERE tournament_id IS NULL AND rake_amount > 0;

COMMENT ON INDEX public.idx_hand_history_cash_rake_unbanked IS
  'Bounds the hourly unbanked-cash-rake search (fn_rake_repair_unbanked). Added after that job timed out at 120s on 4 of 24 consecutive runs; 116s -> 9.8s.';

-- ROLLBACK (online):
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_hand_history_cash_rake_unbanked;
