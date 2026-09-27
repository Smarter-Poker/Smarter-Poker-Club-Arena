-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420090055 "phase41_backfill_default_tables"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c36fb3c05d4dbaf83885f8f7fde731a2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 41 Part B: backfill a default table for every existing home-game event.
-- Defensive clamps even though live data is clean (future-proof against data drift).
INSERT INTO public.commander_home_game_tables
  (game_id, table_number, name, game_type, stakes, format, buyin_min, buyin_max, max_seats, status, is_default, created_by)
SELECT
  g.id,
  1,
  NULL,  -- no name; the UI labels "Main table" when there's only one
  COALESCE(NULLIF(trim(g.game_type), ''), 'NLH'),
  g.stakes,
  CASE WHEN COALESCE(g.format,'cash') IN ('cash','tournament','sitngo','mixed')
       THEN g.format ELSE 'cash' END,
  g.buyin_min,
  g.buyin_max,
  LEAST(10, GREATEST(2, COALESCE(g.max_players, 9))),
  CASE WHEN g.cancelled_at IS NOT NULL THEN 'cancelled' ELSE 'open_for_rsvp' END,
  true,
  g.host_id
FROM public.commander_home_games g
WHERE NOT EXISTS (
  SELECT 1 FROM public.commander_home_game_tables t
   WHERE t.game_id = g.id AND t.is_default = true
);

-- Verify: one default table per existing event, none orphaned
DO $$
DECLARE
  games_count int;
  default_tables_count int;
BEGIN
  SELECT count(*) INTO games_count FROM public.commander_home_games;
  SELECT count(*) INTO default_tables_count
    FROM public.commander_home_game_tables WHERE is_default = true;
  IF default_tables_count <> games_count THEN
    RAISE EXCEPTION 'Backfill mismatch: % games vs % default tables',
      games_count, default_tables_count;
  END IF;
END $$;
