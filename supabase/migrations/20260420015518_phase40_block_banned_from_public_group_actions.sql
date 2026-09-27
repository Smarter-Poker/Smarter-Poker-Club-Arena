-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420015518 "phase40_block_banned_from_public_group_actions"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a7ed66550cbfd9e73850ad468c27c09e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 43: create_home_post_comment and toggle_home_post_like
-- allow banned users of PUBLIC groups to keep commenting and liking.
--
-- Current check:
--   IF is_private AND non-owner AND NOT EXISTS(approved member)
--   THEN RAISE NOT_AUTHORIZED
--
-- When the group is PUBLIC (is_private=false), the top-level AND short-
-- circuits to false, so the check is skipped entirely. A user with
-- status='banned' in the group's member table slips through because
-- public groups don't gate on membership at all.
--
-- Fix: always raise BANNED if the caller has an explicit banned row,
-- independent of public/private. Public groups still allow non-members.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_home_post_comment(
  p_post_id uuid, p_caller_user_id uuid, p_content text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_post     RECORD;
    v_group    RECORD;
    v_new_id   uuid;
    v_is_banned boolean;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;
    IF p_content IS NULL OR length(trim(p_content)) = 0 THEN
        RAISE EXCEPTION 'EMPTY_CONTENT';
    END IF;
    IF length(p_content) > 2000 THEN
        RAISE EXCEPTION 'CONTENT_TOO_LONG';
    END IF;

    SELECT * INTO v_post FROM commander_home_posts WHERE id = p_post_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_post.group_id;

    -- Explicit ban always blocks, regardless of group privacy
    SELECT EXISTS (
      SELECT 1 FROM commander_home_members
       WHERE group_id = v_post.group_id
         AND user_id = p_caller_user_id
         AND status = 'banned'
    ) INTO v_is_banned;
    IF v_is_banned THEN
      RAISE EXCEPTION 'BANNED';
    END IF;

    -- Private groups gate on approved membership
    IF v_group.is_private
       AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members
                        WHERE group_id = v_post.group_id AND user_id = p_caller_user_id
                          AND status = 'approved')
    THEN
        RAISE EXCEPTION 'NOT_AUTHORIZED';
    END IF;

    INSERT INTO commander_home_post_comments (post_id, author_id, content)
    VALUES (p_post_id, p_caller_user_id, trim(p_content))
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object('success', true, 'comment_id', v_new_id);
END;
$function$;

-- Same fix for toggle_home_post_like
CREATE OR REPLACE FUNCTION public.toggle_home_post_like(
  p_post_id uuid, p_caller_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_post        RECORD;
    v_group       RECORD;
    v_existing_id uuid;
    v_action      text;
    v_new_count   int;
    v_is_banned   boolean;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_post FROM commander_home_posts WHERE id = p_post_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_post.group_id;

    SELECT EXISTS (
      SELECT 1 FROM commander_home_members
       WHERE group_id = v_post.group_id
         AND user_id = p_caller_user_id
         AND status = 'banned'
    ) INTO v_is_banned;
    IF v_is_banned THEN
      RAISE EXCEPTION 'BANNED';
    END IF;

    IF v_group.is_private
       AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members
                        WHERE group_id = v_post.group_id AND user_id = p_caller_user_id
                          AND status = 'approved')
    THEN
        RAISE EXCEPTION 'NOT_AUTHORIZED';
    END IF;

    SELECT id INTO v_existing_id FROM commander_home_post_likes
     WHERE post_id = p_post_id AND user_id = p_caller_user_id;

    IF FOUND THEN
        DELETE FROM commander_home_post_likes WHERE id = v_existing_id;
        v_action := 'unliked';
    ELSE
        INSERT INTO commander_home_post_likes (post_id, user_id)
        VALUES (p_post_id, p_caller_user_id);
        v_action := 'liked';
    END IF;

    SELECT likes_count INTO v_new_count FROM commander_home_posts WHERE id = p_post_id;

    RETURN jsonb_build_object('success', true, 'action', v_action, 'likes_count', v_new_count);
END;
$function$;

COMMENT ON FUNCTION public.create_home_post_comment IS
  'Phase 40: explicit BANNED check now applies regardless of group privacy. '
  'Users banned from a public group can no longer bypass the ban by commenting.';
COMMENT ON FUNCTION public.toggle_home_post_like IS
  'Phase 40: explicit BANNED check. Banned users of public groups cannot like.';
