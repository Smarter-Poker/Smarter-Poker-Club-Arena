-- ============================================================================
-- 20260819g_club_dashboard_hand_number_not_unique.sql
-- Club Dashboard stats — withdraw the chunked rebuild (Tier 2)
--
-- Applied to production as: club_dashboard_drop_chunked_rebuild
--
-- A chunked, resumable rebuild was added so that very large legacy tables
-- (65k-75k rows) could be backfilled inside the connector's time ceiling. It
-- resumed by hand_number, on the assumption that hand_number is a total order
-- within a table.
--
-- IT IS NOT. hand_history.hand_number is unique only above 1,000,000 — see
-- the partial index uq_hand_history_global_hand_number. Legacy tables carry
-- BOTH the old per-table 1..N numbering and the newer global numbering, so
-- hand_number repeats and even runs backwards inside one table. Table
-- d421a6df has 75,211 rows spanning hand_number 1 .. 1,223,543 with only
-- 62,906 distinct values; the chunk walker stopped after 435 hands.
--
-- The non-chunked ca_rebuild_club_member_stats_table is NOT affected. It
-- orders with row_number() OVER (ORDER BY hand_number, created_at) and tests
-- adjacency on that row ordinal, so repeated hand_numbers cannot break it.
-- That is the path verified exact: 8,052 fully-attributed hands, 0
-- non-reconciling, sum(deltas) -1138.13 == -(rake+bbj) -1138.13.
--
-- The chunked function is therefore dropped rather than left in place as a
-- subtly-wrong maintenance tool, and the partial rows it wrote are reverted.
--
-- KNOWN LIMITATION (deliberate, documented):
--   Tables with roughly >20k hands cannot be rebuilt in one statement inside
--   the admin connector's time ceiling. They are recorded in
--   club_stats_rebuild_log with rows_written = -1 and skipped. This affects
--   only HISTORICAL backfill on the two largest horse clubs; every NEW hand
--   for every club is attributed correctly by the live trigger, which is
--   incremental and O(players-per-hand). Redoing that deep history needs a
--   resumable walker keyed on (hand_number, created_at, id) — the row order
--   the rebuild already uses — run somewhere without a request timeout.
-- ============================================================================

DROP FUNCTION IF EXISTS public.ca_rebuild_club_member_stats_chunk(uuid, bigint, integer);

ALTER FUNCTION public.ca_rebuild_club_member_stats_table(uuid)
  SET statement_timeout = '170s';
