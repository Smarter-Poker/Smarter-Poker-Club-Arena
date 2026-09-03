-- 140 rows, not 25,851.
--
-- fn_tournament_management_readiness cost 105 ms per call (best 57 ms, measured
-- over 20 real tournaments). The board renders per-row readiness - state,
-- canStart, shortBy - so a page of 100 tournaments spent about 10.5 seconds
-- inside that one function, against an 8 second statement timeout on the
-- `authenticated` role. The union Table Management board was over its own
-- timeout on any tournament-heavy page, and had been for as long as that
-- function cost this much: the old pre-fold path measured 7,716 ms for the same
-- 100 tournaments through fn_get_managed_game_contracts.
--
-- All of it was one query inside that function - the other-live-exposure sum:
--
--   SELECT sum(greatest(guaranteed_prize - prize_pool, 0))
--     FROM tournaments t JOIN clubs c ON c.id = t.club_id
--    WHERE c.union_id = ... AND t.id <> <this one>
--      AND NOT COALESCE(prize_pool_finalized,false)
--      AND upper(status) IN ('ANNOUNCED','REGISTERING','RUNNING')
--
-- EXPLAIN, before: Index Scan using idx_tournaments_club_id, "Rows Removed by
-- Filter: 25,851", 13,975 buffers, 82.7 ms. It read every tournament those
-- clubs had ever run to keep 82 of them, because neither the status test nor
-- the finalized test could use an index - and then it did that again for the
-- next row on the page.
--
-- The set it actually wants is tiny: of 78,372 tournaments, 140 are live and
-- unfinalized. So index exactly those. `upper(status)` cannot use a plain
-- index, but it is immutable and can live in a partial index predicate, which
-- is also what keeps the index small - it holds the live set, not the archive,
-- and rows leave it as they finalize.
--
-- MEASURED AFTER, same query: 107 buffers, 6.6 ms. And the function itself:
--   105.2 ms average -> 0.9 ms average   (a page of 100: 10,524 ms -> 87 ms)
--   union board first page: 11,849 ms -> 1,503 ms
--
-- This changes no logic and no result: it is the same rows, found without
-- reading the ones that do not qualify. Every caller of that function benefits,
-- not only the board - it is also on the tournament start path, where the same
-- scan was being paid.
--
-- Production got this with CREATE INDEX CONCURRENTLY, so no write was blocked
-- on a live 130 MB table. It is recorded here without CONCURRENTLY because a
-- rebuild from these files has no concurrent traffic to protect, and
-- CONCURRENTLY cannot run inside a migration's transaction. IF NOT EXISTS makes
-- this a no-op against the database that already has it.

CREATE INDEX IF NOT EXISTS idx_tournaments_live_unfinalized_guarantee
  ON public.tournaments (club_id)
  INCLUDE (guaranteed_prize, prize_pool)
  WHERE NOT COALESCE(prize_pool_finalized, false)
    AND upper(status) IN ('ANNOUNCED', 'REGISTERING', 'RUNNING');

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'tournaments'
      AND indexname = 'idx_tournaments_live_unfinalized_guarantee'
  ) THEN
    RAISE EXCEPTION 'the guarantee-exposure partial index is missing';
  END IF;
END;
$assert$;