-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417090240 "outlaw_home_game_in_poker_venues"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f8b907d3d7a4cebbe4c76b77b41f76eb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ════════════════════════════════════════════════════════════════════════════
-- poker_venues is for commercial poker rooms only: casinos, poker clubs,
-- series, charities, tours. Home games are a DIFFERENT system living in
-- commander_home_groups, linked to social_pages with page_type='home_game'.
--
-- This CHECK constraint makes it structurally impossible for future code
-- (accidentally or deliberately) to stuff a home game into poker_venues as
-- venue_type='home_game', which would bypass the unified home-games system
-- and sever the social_pages linkage.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.poker_venues
  DROP CONSTRAINT IF EXISTS ck_poker_venues_not_home_game;

ALTER TABLE public.poker_venues
  ADD CONSTRAINT ck_poker_venues_not_home_game
  CHECK (venue_type IS NULL OR venue_type NOT IN ('home_game','homegame','home-game'));
