-- 20260916050120_diamond_bonus_club_foreign_key_is_indexed.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
-- Post-deploy run 35057600805 found diamond_bonus_entries.club_id was the
-- only unindexed club foreign key. The history index leads on user_id and
-- cannot answer a club retirement check. The production catalogue on
-- 2026-09-16 reported zero estimated rows and a zero-byte table heap.
-- Add a full leading-column index; change no game, receipt or financial data.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_diamond_bonus_entries_club_id_fk
  ON public.diamond_bonus_entries (club_id);

COMMIT;
