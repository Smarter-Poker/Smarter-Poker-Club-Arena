-- THE SATELLITE SEAT A TARGET WAS FUNDED BY IS FOUND BY INDEX.
--
-- fn_tournament_conservation_delta has a seat_income term that asks "which
-- satellite seats name THIS event as their target", and it asks it as
--
--   WHERE sp.source = 'satellite_seat'
--     AND sp.metadata->>'satellite_target_id' = t.id::text
--
-- No index can serve a JSON key extraction, so every single call read all
-- 132,381 rows of tournament_payouts - 86 MB - to find at most a handful. The
-- delta is called once per event, and fn_tournament_money_conservation calls it
-- up to a thousand times in its auto-resolve pass alone, so the check spent
-- tens of gigabytes of reads answering a question about 599 rows. It timed out
-- on 2026-09-06 trying to resolve its own backlog.
--
-- The index is on the expression the query actually uses, restricted to the 599
-- satellite_seat rows, and carries the amount so the sum never touches the
-- heap. Nothing about the delta's arithmetic changes; it just stops reading the
-- table to find nothing.
--
-- CONCURRENTLY, and therefore outside a transaction: tournament_payouts is
-- written during every settlement, and a plain CREATE INDEX would hold a lock
-- that stalls payouts for the length of the build.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournament_payouts_satellite_target
  ON public.tournament_payouts ((metadata->>'satellite_target_id'))
  INCLUDE (amount)
  WHERE source = 'satellite_seat';

COMMENT ON INDEX public.idx_tournament_payouts_satellite_target IS
  'Serves fn_tournament_conservation_delta''s seat_income term. Without it the delta scanned all of tournament_payouts on every call.';
