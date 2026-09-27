-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417192735 "phase22_trigger_reconciliation"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ab032ad2af1fdd40fa43d3a375ffb6f6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 22 — Trigger Reconciliation
--  -----------------------------------------------------------------------
--  Resolves four stale-artifact issues uncovered during the Phase 22
--  data-quality audit. All four predate Phase 22; my earlier cleanup
--  UPDATEs made their behaviour observable by bumping last_activity_at on
--  both test groups unexpectedly.
--
--  ISSUE A — duplicate self-bump triggers on commander_home_groups
--    DROP legacy `trg_home_group_self_bump` + its function. Dan's refined
--    `trg_home_group_self_activity` (from 98dbb8cb) stays. The legacy had
--    is_private / is_active / requires_approval in its internal IF clause,
--    which directly cancels the refinement Dan shipped in 98dbb8cb.
--
--  ISSUE B — commander_home_games bumps group activity on every change
--    DROP `trg_bump_activity_on_home_game` + its function. Dan's Phase 18
--    stated rule: "Auto-scheduled tournaments do NOT count as activity.
--    Club Commander allows you to schedule tournaments a year in advance."
--    This trigger violates that — it fires on every tournament mutation.
--
--  ISSUE B2 — duplicate bump trigger on commander_home_members
--    DROP legacy `trg_bump_activity_on_home_member` + its function. The
--    Phase 18 `trg_home_members_bump_activity` (with SECURITY DEFINER)
--    already covers the same AFTER INSERT path — the legacy triggers a
--    redundant double-bump on every join.
--
--  ISSUE C — Phase 16A shadow-venue sync
--    DROP the two sync-to-poker_venues triggers on commander_home_groups.
--    The underlying function and the poker_venues.home_group_id column are
--    KEPT dormant so Phase 16A-style shadow venues can be resurrected
--    cleanly later if needed. Currently zero shadow rows exist; these
--    triggers were firing on every group INSERT/UPDATE but silently
--    failing (no CHECK constraint — likely the failure is downstream in
--    fn_home_group_sync_venue itself, perhaps writing to commander_tables
--    schema that doesn't match anymore).
--
--  ISSUE D — restore last_activity_at on both test groups after my Phase
--    22 cleanup inadvertently bumped them via Issue B's trigger. Now that
--    Issues A and B are dropped, a bare UPDATE of last_activity_at won't
--    cascade (the refined self-bump trigger's WHEN clause doesn't include
--    last_activity_at).
--
--  NOT touched this migration:
--    - `trg_bump_activity_on_home_post` on commander_home_posts (the table
--      is empty, and the trigger is future-compatible if you ever use it)
--    - The shared `fn_bump_home_group_activity` helper (still used by the
--      5 Phase 18 triggers — reviews, rsvps, members, page posts, page
--      reviews)
-- =========================================================================

-- ─── ISSUE A ─────────────────────────────────────────────────────────────
DROP TRIGGER  IF EXISTS trg_home_group_self_bump          ON commander_home_groups;
DROP FUNCTION IF EXISTS public.trg_fn_home_group_self_bump_activity();

-- ─── ISSUE B ─────────────────────────────────────────────────────────────
DROP TRIGGER  IF EXISTS trg_bump_activity_on_home_game    ON commander_home_games;
DROP FUNCTION IF EXISTS public.trg_fn_home_game_bump_activity();

-- ─── ISSUE B2 ────────────────────────────────────────────────────────────
DROP TRIGGER  IF EXISTS trg_bump_activity_on_home_member  ON commander_home_members;
DROP FUNCTION IF EXISTS public.trg_fn_home_member_bump_activity();

-- ─── ISSUE C ─────────────────────────────────────────────────────────────
-- Only the triggers — function and column stay for future resurrection.
DROP TRIGGER IF EXISTS trg_home_group_sync_venue_ins ON commander_home_groups;
DROP TRIGGER IF EXISTS trg_home_group_sync_venue_upd ON commander_home_groups;

-- ─── ISSUE D — restore last_activity_at ─────────────────────────────────
-- Must run AFTER the triggers above are gone, or the legacy self-bump
-- would overwrite back to NOW().
UPDATE commander_home_groups
   SET last_activity_at = '2026-02-26 17:12:35.005783+00'
 WHERE id = '1794b3be-8313-4e82-93da-1b33f7fca801';   -- Saturday Night

UPDATE commander_home_groups
   SET last_activity_at = '2026-02-16 14:48:39.005154+00'
 WHERE id = '41d45c8f-533b-4fea-8c9c-61707fc6e288';   -- High Rollers

-- Tell PostgREST to reload its schema cache
NOTIFY pgrst, 'reload schema';
