-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417152727 "phase16a_revert_shadow_venue_bridge"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f5676077396e3e2fbf2b1b1d991ddd49 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════
--  PHASE 16A REVERT: remove shadow poker_venues for home groups
-- ══════════════════════════════════════════════════════════════════════
--
--  Dan's correction (paraphrased): home games are NOT venues. They're a
--  distinct entity type (home_game) that appears alongside venue cards
--  in the Poker Near Me surface BUT does not increment the venue count.
--  Venue count is reserved for casinos + card clubs.
--
--  Phase 16A created shadow poker_venues rows per home group
--  (is_suppressed=true) so the Club Commander venue-tier tooling would
--  work polymorphically. That was the wrong model. Reverting the schema
--  changes; home groups stay in their own table. The Table Tablet
--  reservation flow will be built natively on commander_home_* tables
--  instead of piggy-backing commander_seats / commander_games.
--
--  SAFE TO REVERT — verified no downstream rows:
--    shadow venues:     2
--    shadow tables:     2  (the auto-created Table 1 for each venue)
--    games on shadows:  0
--    tournaments:       0
--    seats:             0
--
--  Note: the Phase 15 Social Pages quarantine still stands. Home-game
--  social_pages rows stay intact (they back /hub/home-games/{slug} SSR
--  + follow plumbing). Only the poker_venues shadow model is reverted.
-- ══════════════════════════════════════════════════════════════════════

-- Drop triggers first
DROP TRIGGER IF EXISTS trg_home_group_sync_venue_ins ON commander_home_groups;
DROP TRIGGER IF EXISTS trg_home_group_sync_venue_upd ON commander_home_groups;

-- Drop trigger fn
DROP FUNCTION IF EXISTS fn_trg_home_group_sync_venue() CASCADE;
DROP FUNCTION IF EXISTS fn_home_group_sync_venue(uuid);

-- Delete the shadow tables (must go before venues due to FK)
DELETE FROM commander_tables
 WHERE venue_id IN (SELECT id FROM poker_venues WHERE venue_type = 'home_group');

-- Delete the shadow venues
DELETE FROM poker_venues WHERE venue_type = 'home_group';

-- Drop FK + unique index, then the columns themselves
ALTER TABLE poker_venues
  DROP CONSTRAINT IF EXISTS fk_poker_venues_home_group;

DROP INDEX IF EXISTS ux_poker_venues_home_group_id;

ALTER TABLE poker_venues
  DROP COLUMN IF EXISTS home_group_id,
  DROP COLUMN IF EXISTS commander_home_table_id;
