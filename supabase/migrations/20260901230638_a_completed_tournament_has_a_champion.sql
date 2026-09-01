-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 3: THE CHAMPION WHO WAS NEVER MARKED THE CHAMPION
--
-- The 24 unpaid bounty chips were not a bounty bug. The tournament finished
-- with eleven players eliminated at positions 2..12 and the twelfth still
-- carrying tournament_players.status = 'playing' at position 1. The engine
-- marked the EVENT completed and never transitioned the last player to
-- 'winner', so every downstream reader that asks "who won?" finds nobody:
-- bounty finalisation has no recipient, and the pool sits.
--
-- MEASURED across 50,572 completed events: 52 have no winner recorded, and in
-- ALL 52 the champion is sitting in 'playing'. Not one has a different shape,
-- and no event has two winners. Every one falls between 2026-08-21 05:57 and
-- 2026-08-27 01:17; 15,163 events have completed since without a single
-- recurrence, so the engine defect itself is already closed.
--
-- What was NOT closed is that nothing would have told us. There was no guard
-- saying a finished tournament must have a champion, so the 52 sat for eleven
-- days and surfaced only because one of them happened to hold a bounty pool
-- that a different check noticed.
--
-- No money is moved here. The ratchet is wired into fn_ca_ratchet_watch in
-- 20260901231436_the_overpay_ratchet_joins_the_hourly_watch.sql, which carries
-- the final body of that function for this batch.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_ca_completed_without_a_champion()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT count(*)::int
    FROM public.tournaments t
   WHERE t.status = 'COMPLETED'
     AND EXISTS (SELECT 1 FROM public.tournament_players tp
                  WHERE tp.tournament_id = t.id)
     AND NOT EXISTS (SELECT 1 FROM public.tournament_players tp
                      WHERE tp.tournament_id = t.id AND tp.status = 'winner');
$fn$;

COMMENT ON FUNCTION public.fn_ca_completed_without_a_champion() IS
  'Completed tournaments that have players but nobody marked winner. Every one is a settlement that cannot complete: bounty pools, prizes and stats all read status=winner. 52 on 2026-09-01, all from the 2026-08-21..27 window, all with the champion still in status=playing.';

REVOKE ALL ON FUNCTION public.fn_ca_completed_without_a_champion() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_completed_without_a_champion() TO service_role;

INSERT INTO public.ca_ratchet_baselines (ratchet, baseline, note)
SELECT 'completed_without_a_champion',
       public.fn_ca_completed_without_a_champion(),
       'Completed tournaments with players but no winner recorded. All 52 are the 2026-08-21..27 cohort where the engine left the champion in status=playing; 15,163 events have completed since with no recurrence. The count can only fall. A rise means the engine has stopped naming champions again, and every settlement downstream of that is stuck.'
ON CONFLICT (ratchet) DO NOTHING;
