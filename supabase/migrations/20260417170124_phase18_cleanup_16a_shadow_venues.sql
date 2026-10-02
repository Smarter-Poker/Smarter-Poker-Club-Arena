-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417170124 "phase18_cleanup_16a_shadow_venues"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 51ef5effbc9b885a3e222733102e4cb9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════
--  CLEANUP: Phase 16A shadow poker_venues residue
-- ══════════════════════════════════════════════════════════════════════
--
--  Phase 16A (reverted) created shadow poker_venues rows to bridge
--  home groups into the Club Commander venue-scoped tooling. Dan
--  reverted the schema (column, triggers, bridge function) but the
--  shadow VENUE ROWS themselves survived the revert — they were
--  created via the now-deleted trigger but remain as plain poker_venues
--  rows with source='home_group_shadow'.
--
--  Discovered during Phase 18 verification: these rows were leaking
--  into Poker Near Me with venue_type='home_group' because the PNM
--  venues API had no reason to exclude them (the constraint is against
--  venue_type='home_game' specifically; 'home_group' was allowed).
--
--  Removing them finally completes the Phase 16A revert. Home groups
--  will flow into PNM via a read-time UNION from commander_home_groups
--  with the Phase 18 30-day filter baked in.
-- ══════════════════════════════════════════════════════════════════════

-- Drop the 2 commander_tables rows first (FK dependency)
DELETE FROM commander_tables
 WHERE venue_id IN (
   SELECT id FROM poker_venues WHERE source = 'home_group_shadow'
 );

-- Then the shadow venues themselves
DELETE FROM poker_venues
 WHERE source = 'home_group_shadow';
