-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260511163107 "add_tournament_columns_to_commander_home_games"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 24225ac524cb005805f98fb92054b174 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Tournament feature buildout: extend commander_home_games to support tournaments.
-- Tournaments are NOT a separate table — they are home-game events with format='tournament'.
-- This reuses the entire existing event infrastructure (RSVPs, lifecycle, triggers, notifications).

-- Add tournament-specific columns
ALTER TABLE public.commander_home_games
  ADD COLUMN IF NOT EXISTS starting_stack integer,
  ADD COLUMN IF NOT EXISTS structure text;

-- Constrain structure to known tournament types
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commander_home_games'::regclass
      AND conname = 'commander_home_games_structure_check'
  ) THEN
    ALTER TABLE public.commander_home_games
      ADD CONSTRAINT commander_home_games_structure_check
      CHECK (structure IS NULL OR structure IN ('turbo','standard','deep','bounty','rebuy'));
  END IF;
END$$;

-- Index for fast upcoming-tournaments lookups per group
CREATE INDEX IF NOT EXISTS commander_home_games_group_format_date_idx
  ON public.commander_home_games (group_id, format, scheduled_date)
  WHERE format = 'tournament';

COMMENT ON COLUMN public.commander_home_games.starting_stack
  IS 'Tournament starting chip stack. NULL for cash games.';
COMMENT ON COLUMN public.commander_home_games.structure
  IS 'Tournament structure: turbo|standard|deep|bounty|rebuy. NULL for cash games.';
