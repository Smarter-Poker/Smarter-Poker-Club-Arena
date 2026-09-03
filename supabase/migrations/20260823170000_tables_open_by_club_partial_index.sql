-- ═══════════════════════════════════════════════════════════════════════════
-- QUICK JOIN SPENT 6.7 SECONDS ON "FINDING GAMES…" (2026-08-23)
-- ═══════════════════════════════════════════════════════════════════════════
-- Pressing "+" on a table opens the Quick Join sheet, which asks for the open
-- games in your club:
--
--     select id, name, game_variant, ... from tables
--      where club_id = $1
--        and tournament_id is null
--        and status <> 'closed'
--        and is_deleted is not true
--      limit 30
--
-- Measured from production on 2026-08-23: 6,707 ms at the browser. The sheet
-- renders "Finding Games…" for that whole time, and on a slower connection it
-- runs past 18 s — which is indistinguishable from the button being broken,
-- and is exactly how it was reported.
--
-- WHERE THE TIME GOES — it is not the raw query
--
--   Limit  (actual time=8.257..11.499 rows=30)
--     ->  Index Scan using idx_tables_club_id on tables
--           Index Cond: (club_id = 'fade0000-...'::uuid)
--           Filter: (tournament_id IS NULL AND is_deleted IS NOT TRUE
--                    AND status <> 'closed')
--           ROWS REMOVED BY FILTER: 7261
--
-- 11 ms as service_role. The cost is what that plan does under RLS. To return
-- 30 open tables it walks 7,291 heap rows in that club — 7,261 of them closed
-- or deleted — and `tables_select_scoped` runs
--
--     is_club_member(club_id, auth.uid())  OR
--     fn_union_oversees_club(club_id, auth.uid())  OR  (EXISTS ... clubs)
--
-- against each one. Two function calls per discarded row, ~14.5k calls for a
-- 30-row answer. The club has 64,374 closed tables and grows by every hand
-- ever dealt, so this gets worse every day on its own.
--
-- THE FIX: make the index carry the open-ness predicate, so the scan visits
-- the ~30 rows that can actually be returned and RLS runs ~30 times instead of
-- ~7,291. `tournament_id` rides along as a key column so the cash-game filter
-- (IS NULL) and the tournament-table lookups both stay in the index.
--
-- MEASURED AFTER (same query, same club, immediately after ANALYZE):
--
--   Limit  (actual time=0.042..0.297 rows=30)
--     ->  Index Scan using idx_tables_open_by_club on tables
--           Index Cond: (club_id = 'fade0000-...' AND tournament_id IS NULL)
--           Buffers: shared hit=35
--   Execution Time: 0.376 ms
--
-- 11.588 ms -> 0.376 ms, 1,480 buffers -> 35, and the "Rows Removed by Filter:
-- 7261" line is gone: the predicate is satisfied by the index itself, so there
-- are no discarded rows left for the policy to be evaluated against.
--
-- Additive and reversible: no existing index is dropped, no policy changes,
-- no data is touched. ROLLBACK is the DROP INDEX at the bottom of this file.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_tables_open_by_club
  ON public.tables (club_id, tournament_id)
  WHERE status <> 'closed' AND is_deleted IS NOT TRUE;

-- Assert the outcome rather than trusting the statement above.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'tables'
    AND indexname = 'idx_tables_open_by_club';

  IF n <> 1 THEN
    RAISE EXCEPTION 'idx_tables_open_by_club was not created (found % matching indexes)', n;
  END IF;
END $$;

-- Fresh statistics so the planner actually prefers the new index on the first
-- Quick Join after this migration rather than after autovacuum gets round to it.
ANALYZE public.tables;

-- ROLLBACK
--   DROP INDEX IF EXISTS public.idx_tables_open_by_club;
