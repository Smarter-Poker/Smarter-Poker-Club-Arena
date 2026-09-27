-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424005021 "20260421120000_hg_seats_status_hot_path_indexes"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7331d14f7caff68cd6ebea76dac020fa of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- commander_home_seats: "available seats in this game/table" is a
-- critical hot path. Every game lobby loads this query. Existing
-- indexes cover the uniqueness constraints and user_id scans, but
-- there's no status-filtered index, so PG does a filter-in-memory
-- after game_id/table_id scan.
--
-- Add two partial composite indexes covering both seat-worlds:
--   Legacy (game_id-rooted): (game_id, status) WHERE table_id IS NULL
--   Multi-table: (table_id, status) WHERE table_id IS NOT NULL
--
-- Partial indexes keep them tight and avoid competing with the
-- existing unique indexes.

CREATE INDEX IF NOT EXISTS idx_commander_home_seats_legacy_game_status
  ON public.commander_home_seats (game_id, status)
  WHERE table_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_commander_home_seats_table_status
  ON public.commander_home_seats (table_id, status)
  WHERE table_id IS NOT NULL;

-- Tiny helper for an empty-seat-only query pattern (common in lobby)
CREATE INDEX IF NOT EXISTS idx_commander_home_seats_empty_by_game
  ON public.commander_home_seats (game_id)
  WHERE status = 'empty' AND table_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_commander_home_seats_empty_by_table
  ON public.commander_home_seats (table_id)
  WHERE status = 'empty' AND table_id IS NOT NULL;
