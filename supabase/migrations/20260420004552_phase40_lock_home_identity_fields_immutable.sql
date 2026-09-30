-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420004552 "phase40_lock_home_identity_fields_immutable"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3261d6ff806ea7dcad4409f3130e6b69 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40: identity fields on home-games tables must be immutable.
--
-- Bug class: UPDATE RLS policies allow staff/author/owner to mutate any
-- field on rows they can edit, including the identity fields that establish
-- WHO owns the row (host_id, author_id, reviewer_id, uploader_id,
-- created_by, user_id). This enables:
--   - A group owner secretly transferring a game to another user (host_id rewrite)
--   - An owner rewriting post authorship (author_id rewrite)
--   - A user rewriting their own RSVP user_id to impersonate
--   - A poll creator or group owner rewriting poll created_by
--   - A review author rewriting reviewer_id to misattribute their review
--
-- Fix: generic BEFORE UPDATE trigger that raises when any declared identity
-- field has changed. Skips when auth.uid() IS NULL (cron/migration/trigger-
-- chain contexts have no JWT). Service-role callers also have auth.uid() = NULL
-- so server-side admin paths still work.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_home_protect_identity_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET row_security TO off
AS $function$
DECLARE
  v_field text;
  v_old_val text;
  v_new_val text;
BEGIN
  -- No JWT → internal operation (cron, migration, trigger cascade from
  -- another trigger that's already validated). Allow.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- service_role bypass (server-side admin code paths are trusted)
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;

  FOREACH v_field IN ARRAY TG_ARGV LOOP
    EXECUTE format('SELECT ($1).%I::text, ($2).%I::text', v_field, v_field)
      INTO v_old_val, v_new_val
      USING OLD, NEW;

    IF v_old_val IS DISTINCT FROM v_new_val THEN
      RAISE EXCEPTION
        'Cannot change %.% after creation (was %, attempted %). '
        'Identity fields are immutable.',
        TG_TABLE_NAME, v_field, COALESCE(v_old_val,'<null>'), COALESCE(v_new_val,'<null>')
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fn_home_protect_identity_fields IS
  'Phase 40: blocks UPDATE of identity fields (passed as TG_ARGV) by any '
  'authenticated caller. Skipped for cron/migration (no auth.uid()) and '
  'service_role. Used by per-table BEFORE UPDATE triggers.';

-- ----------------------------------------------------------------------------
-- Attach triggers to each table with the list of fields that must be
-- immutable after INSERT.
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_home_games_protect_identity ON commander_home_games;
CREATE TRIGGER trg_home_games_protect_identity
  BEFORE UPDATE ON commander_home_games
  FOR EACH ROW
  EXECUTE FUNCTION fn_home_protect_identity_fields('host_id', 'group_id');

DROP TRIGGER IF EXISTS trg_home_posts_protect_identity ON commander_home_posts;
CREATE TRIGGER trg_home_posts_protect_identity
  BEFORE UPDATE ON commander_home_posts
  FOR EACH ROW
  EXECUTE FUNCTION fn_home_protect_identity_fields('author_id', 'group_id');

DROP TRIGGER IF EXISTS trg_home_post_comments_protect_identity ON commander_home_post_comments;
CREATE TRIGGER trg_home_post_comments_protect_identity
  BEFORE UPDATE ON commander_home_post_comments
  FOR EACH ROW
  EXECUTE FUNCTION fn_home_protect_identity_fields('author_id', 'post_id');

DROP TRIGGER IF EXISTS trg_home_rsvps_protect_identity ON commander_home_rsvps;
CREATE TRIGGER trg_home_rsvps_protect_identity
  BEFORE UPDATE ON commander_home_rsvps
  FOR EACH ROW
  EXECUTE FUNCTION fn_home_protect_identity_fields('user_id', 'game_id');

DROP TRIGGER IF EXISTS trg_home_polls_protect_identity ON commander_home_polls;
CREATE TRIGGER trg_home_polls_protect_identity
  BEFORE UPDATE ON commander_home_polls
  FOR EACH ROW
  EXECUTE FUNCTION fn_home_protect_identity_fields('created_by', 'group_id');

DROP TRIGGER IF EXISTS trg_home_poll_votes_protect_identity ON commander_home_poll_votes;
CREATE TRIGGER trg_home_poll_votes_protect_identity
  BEFORE UPDATE ON commander_home_poll_votes
  FOR EACH ROW
  EXECUTE FUNCTION fn_home_protect_identity_fields('user_id', 'poll_id');

DROP TRIGGER IF EXISTS trg_home_post_likes_protect_identity ON commander_home_post_likes;
CREATE TRIGGER trg_home_post_likes_protect_identity
  BEFORE UPDATE ON commander_home_post_likes
  FOR EACH ROW
  EXECUTE FUNCTION fn_home_protect_identity_fields('user_id', 'post_id');

DROP TRIGGER IF EXISTS trg_home_game_reviews_protect_identity ON commander_home_game_reviews;
CREATE TRIGGER trg_home_game_reviews_protect_identity
  BEFORE UPDATE ON commander_home_game_reviews
  FOR EACH ROW
  EXECUTE FUNCTION fn_home_protect_identity_fields('reviewer_id', 'game_id');

DROP TRIGGER IF EXISTS trg_home_game_photos_protect_identity ON commander_home_game_photos;
CREATE TRIGGER trg_home_game_photos_protect_identity
  BEFORE UPDATE ON commander_home_game_photos
  FOR EACH ROW
  EXECUTE FUNCTION fn_home_protect_identity_fields('uploader_id', 'game_id');
