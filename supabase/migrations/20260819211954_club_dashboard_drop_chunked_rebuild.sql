-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819211954 "club_dashboard_drop_chunked_rebuild"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 bc66f2844591e9d23ef79266dfc30980 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Withdrawing ca_rebuild_club_member_stats_chunk.
--
-- It resumed by hand_number, on the assumption that hand_number is a total
-- order within a table. It is not: hand_history.hand_number is only unique
-- above 1,000,000 (see uq_hand_history_global_hand_number), and legacy tables
-- carry BOTH the old per-table 1..N numbering and the newer global numbering.
-- Table d421a6df has 75,211 rows spanning hand_number 1 .. 1,223,543 with only
-- 62,906 distinct values, so the chunk walker stopped after 435 hands.
--
-- The non-chunked ca_rebuild_club_member_stats_table is NOT affected: it
-- orders with row_number() OVER (ORDER BY hand_number, created_at) and tests
-- adjacency on that row ordinal, so repeated hand_numbers cannot break it.
-- That is the path verified exact (0 non-reconciling over 7,958 hands).
--
-- Leaving a subtly-wrong maintenance function in place is worse than not
-- having one, so it is dropped and the partial rows it wrote are reverted.
DROP FUNCTION IF EXISTS public.ca_rebuild_club_member_stats_chunk(uuid, bigint, integer);

DELETE FROM club_member_daily_stats  WHERE table_id = 'd421a6df-31cc-4038-af27-2ce7ce417d26';
DELETE FROM club_member_table_state  WHERE table_id = 'd421a6df-31cc-4038-af27-2ce7ce417d26';
DELETE FROM club_stats_rebuild_log   WHERE table_id = 'd421a6df-31cc-4038-af27-2ce7ce417d26';

-- Keep the per-table function's timeout at a value the connector tolerates;
-- oversized legacy tables are recorded as failures and retried deliberately
-- rather than silently half-written.
ALTER FUNCTION public.ca_rebuild_club_member_stats_table(uuid)
  SET statement_timeout = '170s';
