-- Write-tax removal, 2026-08-24 global performance pass.
--
-- Supabase advisors report 1,341 unused indexes. Every one must still be
-- maintained on every INSERT, UPDATE and DELETE of its table, for zero read
-- benefit. On a write-heavy poker platform that is a direct tax on the hot path.
--
-- This drops only indexes that are simultaneously: never scanned
-- (idx_scan = 0), not backing a constraint, and on a table with more than
-- 100,000 lifetime writes. That is five indexes, and it is where the tax is
-- actually paid.
--
-- "Never scanned" is trustworthy: pg_stat_database.stats_reset is NULL for this
-- database, so counters are cumulative since the project was created on
-- 2026-01-06 - seven months of zero reads, not a fresh window.
--
-- The standout is hand_state_snapshots_table_updated_idx at 319 MB on a table
-- taking 188,739 writes. It was also pure drag on the pruning job: that job
-- drives its scan from idx_hand_state_snapshots_created_at and then DELETEs,
-- and every delete also had to remove entries from this 319 MB index. The prune
-- had been hitting its own statement timeout 24 times in a 3-hour window.
--
-- Tier 2. APPLIED TO PRODUCTION via Supabase MCP apply_migration 2026-08-24,
-- assertions green.

DROP INDEX IF EXISTS public.hand_state_snapshots_table_updated_idx;  -- btree (table_id, updated_at)
DROP INDEX IF EXISTS public.idx_cmds_club_date;                      -- btree (club_id, stat_date)
DROP INDEX IF EXISTS public.idx_tournament_players_table_id;         -- btree (table_id) WHERE table_id IS NOT NULL
DROP INDEX IF EXISTS public.idx_member_fee_rollup_user_day;          -- btree (user_id, day)
DROP INDEX IF EXISTS public.idx_member_fee_rollup_day;               -- btree (day)

DO $$
DECLARE v_left bigint; v_names text;
BEGIN
  SELECT count(*), coalesce(string_agg(relname, ', '), '') INTO v_left, v_names
    FROM pg_class
   WHERE relname IN ('hand_state_snapshots_table_updated_idx','idx_cmds_club_date',
                     'idx_tournament_players_table_id','idx_member_fee_rollup_user_day',
                     'idx_member_fee_rollup_day');
  IF v_left <> 0 THEN RAISE EXCEPTION 'indexes survived the drop: %', v_names; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname='idx_hand_state_snapshots_created_at') THEN
    RAISE EXCEPTION 'idx_hand_state_snapshots_created_at is missing - the prune job depends on it';
  END IF;
END $$;

-- ROLLBACK:
--   CREATE INDEX hand_state_snapshots_table_updated_idx ON public.hand_state_snapshots USING btree (table_id, updated_at);
--   CREATE INDEX idx_cmds_club_date ON public.club_member_daily_stats USING btree (club_id, stat_date);
--   CREATE INDEX idx_tournament_players_table_id ON public.tournament_players USING btree (table_id) WHERE table_id IS NOT NULL;
--   CREATE INDEX idx_member_fee_rollup_user_day ON public.member_fee_rollup USING btree (user_id, day);
--   CREATE INDEX idx_member_fee_rollup_day ON public.member_fee_rollup USING btree (day);
