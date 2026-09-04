-- 20260904083526_stats_phase_1_hand_player_stat_hand_id_index.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- ca_hand_player_stat is keyed (user_id, hand_id) and indexed
-- (user_id, created_at). Nothing leads with hand_id, so any question that
-- starts from a HAND - "which hands in the last ten minutes have no stat row",
-- the witness audit in the next migration, the per-cell hand list the Hands
-- tab wants, a delete-by-hand - is a 1M-row sequential scan. The first probe
-- of the audit query hit the 8 s statement timeout on exactly that anti-join.
--
-- ca_hand_player_idx already carries this index for the same reason
-- (20260830212026). This is the matching one on the stat table.
--
-- ONE STATEMENT, NO TRANSACTION, ON PURPOSE. CREATE INDEX CONCURRENTLY cannot
-- run inside a transaction block, and it is what keeps the live trigger
-- (trg_ca_stats_live_from_hand, which writes this table inside every hand
-- insert) from blocking behind a table lock while the index builds. One
-- statement is one schema-cache reload, which the DDL policy allows. The
-- table is 1.0M rows / 543 MB; the build measured seconds, not minutes.

SET statement_timeout = '600s';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ca_hand_player_stat_hand_id
  ON public.ca_hand_player_stat (hand_id);
