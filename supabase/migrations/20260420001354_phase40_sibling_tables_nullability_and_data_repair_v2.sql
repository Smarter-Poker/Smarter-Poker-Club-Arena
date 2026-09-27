-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420001354 "phase40_sibling_tables_nullability_and_data_repair_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9a558c8351ad5275502e74d42209fa47 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 40: sibling tables cleanup + NOT NULL hardening
-- (Retry after fixing fn_auto_promote_waitlist cascade bug)

-- (a) Delete the one NULL-host test-seed game
DELETE FROM commander_home_games WHERE host_id IS NULL;

-- (b) Reassign games whose host isn't an approved member → group owner
UPDATE commander_home_games g
SET host_id = gr.owner_id
FROM commander_home_groups gr
WHERE gr.id = g.group_id
  AND g.host_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM commander_home_members m
    WHERE m.group_id = g.group_id AND m.user_id = g.host_id AND m.status = 'approved'
  );

-- (c) Delete non-member RSVPs on PRIVATE groups
DELETE FROM commander_home_rsvps r
USING commander_home_games g, commander_home_groups gr
WHERE r.game_id = g.id
  AND g.group_id = gr.id
  AND gr.is_private = true
  AND r.user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM commander_home_members m
    WHERE m.group_id = gr.id AND m.user_id = r.user_id AND m.status = 'approved'
  );

-- Sanity
DO $$
DECLARE v_nulls int;
BEGIN
  SELECT (SELECT COUNT(*) FROM commander_home_games WHERE host_id IS NULL OR group_id IS NULL) +
         (SELECT COUNT(*) FROM commander_home_posts WHERE author_id IS NULL OR group_id IS NULL) +
         (SELECT COUNT(*) FROM commander_home_rsvps WHERE user_id IS NULL OR game_id IS NULL)
    INTO v_nulls;
  IF v_nulls > 0 THEN
    RAISE EXCEPTION 'Cannot harden NOT NULL: % row(s) still have NULLs', v_nulls;
  END IF;
END $$;

-- Schema hardening
ALTER TABLE commander_home_games ALTER COLUMN host_id  SET NOT NULL;
ALTER TABLE commander_home_games ALTER COLUMN group_id SET NOT NULL;
ALTER TABLE commander_home_posts ALTER COLUMN author_id SET NOT NULL;
ALTER TABLE commander_home_posts ALTER COLUMN group_id  SET NOT NULL;
ALTER TABLE commander_home_rsvps ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE commander_home_rsvps ALTER COLUMN game_id SET NOT NULL;

COMMENT ON COLUMN commander_home_games.host_id IS 'Phase 40: NOT NULL. Every game has a host.';
COMMENT ON COLUMN commander_home_games.group_id IS 'Phase 40: NOT NULL. Every game belongs to a group.';
COMMENT ON COLUMN commander_home_posts.author_id IS 'Phase 40: NOT NULL. Every post has an author.';
COMMENT ON COLUMN commander_home_posts.group_id IS 'Phase 40: NOT NULL. Every post belongs to a group.';
COMMENT ON COLUMN commander_home_rsvps.user_id IS 'Phase 40: NOT NULL. Every RSVP has a user.';
COMMENT ON COLUMN commander_home_rsvps.game_id IS 'Phase 40: NOT NULL. Every RSVP is against a game.';
