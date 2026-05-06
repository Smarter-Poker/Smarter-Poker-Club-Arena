-- ═══════════════════════════════════════════════════════════════════════════════
-- SENTRY ERROR REMEDIATION — Fix all 4 unresolved production errors
-- Date: 2026-04-25
-- Issues:
--   JAVASCRIPT-REACT-AH/AM  →  club_members.reputation_xp column missing
--   JAVASCRIPT-REACT-AJ     →  training_achievement_definitions table empty (FK violations)
--   JAVASCRIPT-REACT-AK     →  club_members not in supabase_realtime publication
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- FIX 1: Add reputation_xp column to club_members (JAVASCRIPT-REACT-AH + AM)
-- Error: "column club_members.reputation_xp does not exist"
-- The column was intended by migration 20260124800_complete_club_members.sql
-- but never applied to the live database.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.club_members
  ADD COLUMN IF NOT EXISTS reputation_xp INTEGER NOT NULL DEFAULT 0;

-- Also add companion columns that the service layer references but may be missing
ALTER TABLE public.club_members
  ADD COLUMN IF NOT EXISTS trust_score   INTEGER NOT NULL DEFAULT 50;

ALTER TABLE public.club_members
  ADD COLUMN IF NOT EXISTS rank_level    INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.club_members
  ADD COLUMN IF NOT EXISTS sessions_played INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.club_members
  ADD COLUMN IF NOT EXISTS orange_ball_status TEXT NOT NULL DEFAULT 'cold';

ALTER TABLE public.club_members
  ADD COLUMN IF NOT EXISTS hands_played  INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.club_members
  ADD COLUMN IF NOT EXISTS chips_won     BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.club_members
  ADD COLUMN IF NOT EXISTS chips_lost    BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.club_members
  ADD COLUMN IF NOT EXISTS total_rake_paid BIGINT NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- FIX 2: Seed training_achievement_definitions so FK constraint doesn't fire
-- Error: "Key (achievement_id)=(hands_100) is not present in table
--         training_achievement_definitions"
-- AchievementService uses hardcoded IDs that must exist in this table.
-- ─────────────────────────────────────────────────────────────────────────────

-- Ensure the table exists (it may have been created without seed data)
CREATE TABLE IF NOT EXISTS public.training_achievement_definitions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  category    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS (safe default)
ALTER TABLE public.training_achievement_definitions ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read definitions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'training_achievement_definitions'
      AND policyname = 'allow_read_achievement_definitions'
  ) THEN
    CREATE POLICY "allow_read_achievement_definitions"
      ON public.training_achievement_definitions
      FOR SELECT
      USING (true);
  END IF;
END $$;

-- Insert all achievement IDs used by AchievementService (upsert — safe to re-run)
INSERT INTO public.training_achievement_definitions (id, name, description, category)
VALUES
  -- Hands Played
  ('hands_100',     'Getting Started',      'Play 100 hands',         'hands'),
  ('hands_1000',    'Regular',              'Play 1,000 hands',       'hands'),
  ('hands_10000',   'Grinder',              'Play 10,000 hands',      'hands'),
  ('hands_100000',  'Professional',         'Play 100,000 hands',     'hands'),
  -- Wins
  ('wins_10',       'First Blood',          'Win 10 hands',           'wins'),
  ('wins_100',      'Winner',               'Win 100 hands',          'wins'),
  ('wins_1000',     'Dominator',            'Win 1,000 hands',        'wins'),
  -- Social
  ('friends_5',     'Social Butterfly',     'Add 5 friends',          'social'),
  ('friends_25',    'Popular',              'Add 25 friends',         'social'),
  ('clubs_3',       'Club Hopper',          'Join 3 clubs',           'social'),
  -- Financial
  ('profit_1000',   'In the Green',         'Profit 1,000 chips',     'financial'),
  ('profit_10000',  'High Roller',          'Profit 10,000 chips',    'financial'),
  ('biggest_pot_500','Big Pot',             'Win a 500+ chip pot',    'financial'),
  -- Tournament
  ('tourney_win_1',     'Champion',         'Win a tournament',       'tournament'),
  ('tourney_top3_10',   'Consistent',       'Finish top 3 in 10 tournaments', 'tournament'),
  ('tourney_played_50', 'Tournament Regular','Play 50 tournaments',   'tournament'),
  -- Special
  ('royal_flush',   'Royal Flush',          'Hit a Royal Flush',      'special'),
  ('straight_flush','Straight Flush',       'Hit a Straight Flush',   'special'),
  ('quads',         'Four of a Kind',       'Hit Quads',              'special'),
  ('bad_beat',      'Bad Beat Survivor',    'Lose with quads or better','special'),
  -- Streaks
  ('streak_7',      'Weekly Warrior',       'Log in 7 days in a row', 'special'),
  ('streak_30',     'Monthly Grinder',      'Log in 30 days in a row','special'),
  ('streak_100',    'Centurion',            'Log in 100 days in a row','special')
ON CONFLICT (id) DO UPDATE
  SET name        = EXCLUDED.name,
      description = EXCLUDED.description,
      category    = EXCLUDED.category;

-- Add the FK constraint on training_user_achievements if it doesn't already
-- point at training_achievement_definitions (it currently does, just ensure
-- the data exists so inserts succeed)

-- ─────────────────────────────────────────────────────────────────────────────
-- FIX 3: Add club_members to supabase_realtime publication (JAVASCRIPT-REACT-AK)
-- Error: "mismatch between server and client bindings for postgres changes"
-- HomePage subscribes to club_members changes but the table isn't published.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND tablename = 'club_members'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.club_members;
    RAISE NOTICE 'club_members added to supabase_realtime';
  ELSE
    RAISE NOTICE 'club_members already in supabase_realtime — skipped';
  END IF;
END $$;

-- Also ensure clubs is in realtime (HomePage subscribes to this too)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND tablename = 'clubs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.clubs;
    RAISE NOTICE 'clubs added to supabase_realtime';
  ELSE
    RAISE NOTICE 'clubs already in supabase_realtime — skipped';
  END IF;
END $$;

-- Verification query (informational — returns results after migration runs)
SELECT
  'reputation_xp exists' AS check_name,
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'club_members' AND column_name = 'reputation_xp'
  ) AS result
UNION ALL
SELECT
  'achievement_definitions seeded',
  (SELECT COUNT(*) FROM public.training_achievement_definitions) > 0
UNION ALL
SELECT
  'club_members in realtime',
  EXISTS(
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'club_members'
  );
