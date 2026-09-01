-- Applied to production 2026-09-01 as schema_migrations version 20260901121741
-- (registered name: 20260901_fk_index_only_where_evidence_supports_it).
--
-- Phase 4 / 2: index ONE unindexed foreign key, and record why the other 24
-- are correctly left alone.
--
-- The performance advisor reports 25 unindexed foreign keys. The reflex is to add
-- 25 indexes. That reflex is wrong here, and this database is the proof: it already
-- carries 1,146 never-scanned indexes. Silencing a linter by creating more of the
-- exact thing the next lint complains about is decoration, not a fix.
--
-- An unindexed FK costs something only when the PARENT row is deleted or its key
-- updated: the child table must then be scanned. So the question is not "is there
-- an index" but "is the parent ever deleted, and is the child big enough that
-- scanning it hurts". Measured, 2026-09-01:
--
--   parent                                n_tup_del (lifetime)
--   profiles                              180
--   clubs                                   8
--   poker_venues                            0
--   promotions                              0
--   unions                                  0
--   theme_preset_catalog                    0
--   avatar_shop_catalog                     0
--   leak_drill_sessions                     0
--   leaderboard_reward_program_versions     0
--
-- Every child table of those parents in the unindexed set holds <= 832 rows, and
-- most hold 0. A sequential scan of 832 rows on a parent delete that has happened
-- eight times in the life of the database is not a cost worth an index that would
-- then be maintained on every write forever.
--
-- The one exception, and the only index this migration creates:
--
--   client_shell_telemetry.user_id -> auth.users, ON DELETE SET NULL, 17,587 rows.
--   auth.users deletions are a real, recurring event (account deletion), and each
--   one currently seq-scans the whole telemetry table to null the column out.
--
-- Deliberately NOT using CREATE INDEX CONCURRENTLY: it cannot run inside a
-- transaction, and a migration that is not transactional cannot roll back. The
-- table is 6 MB, so the ACCESS EXCLUSIVE lock is sub-second, and it is a telemetry
-- table on no user-facing read path.
--
-- ROLLBACK: DROP INDEX IF EXISTS public.idx_client_shell_telemetry_user_id;

CREATE INDEX IF NOT EXISTS idx_client_shell_telemetry_user_id
  ON public.client_shell_telemetry USING btree (user_id);

COMMENT ON INDEX public.idx_client_shell_telemetry_user_id IS
  'Backs client_shell_telemetry_user_id_fkey (ON DELETE SET NULL to auth.users). '
  'Added 2026-09-01: the only one of 25 unindexed FKs whose child table is large '
  'enough (17,587 rows) and whose parent is deleted often enough to justify it. '
  'The other 24 are deliberately unindexed - see migration '
  '20260901121741_fk_index_only_where_evidence_supports_it.';

DO $$
DECLARE v_ok boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_client_shell_telemetry_user_id'
      AND i.indisvalid
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'idx_client_shell_telemetry_user_id was not created, or is invalid';
  END IF;
END $$;
