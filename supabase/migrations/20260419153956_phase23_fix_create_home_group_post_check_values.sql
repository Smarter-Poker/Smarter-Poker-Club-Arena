-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419153956 "phase23_fix_create_home_group_post_check_values"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d4368a49e7049ae6d67400c1c6c37819 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Align RPC with actual schema CHECK constraints:
--   post_type IN ('announcement','game_recap','photo','update')
--   visible_to IN ('public','members')
-- Prior version used synthetic values ('regular','poll','members_only','all_public','admins_only')
-- that don't exist in the constraint set.

CREATE OR REPLACE FUNCTION public.create_home_group_post(
    p_group_id         uuid,
    p_caller_user_id   uuid,
    p_content          text,
    p_post_type        text DEFAULT 'update',
    p_image_urls       text[] DEFAULT NULL,
    p_video_url        text DEFAULT NULL,
    p_is_pinned        boolean DEFAULT false,
    p_visible_to       text DEFAULT 'members'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_group         RECORD;
    v_caller_role   text;
    v_caller_status text;
    v_is_host       boolean := false;
    v_new_id        uuid;
    v_valid_types   text[] := ARRAY['announcement','game_recap','photo','update'];
    v_valid_visi    text[] := ARRAY['public','members'];
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    IF p_content IS NULL OR length(trim(p_content)) = 0 THEN
        RAISE EXCEPTION 'EMPTY_CONTENT';
    END IF;

    IF length(p_content) > 10000 THEN
        RAISE EXCEPTION 'CONTENT_TOO_LONG';
    END IF;

    IF NOT (p_post_type = ANY (v_valid_types)) THEN
        RAISE EXCEPTION 'INVALID_POST_TYPE' 
              USING HINT = 'must be one of: announcement, game_recap, photo, update';
    END IF;

    IF NOT (p_visible_to = ANY (v_valid_visi)) THEN
        RAISE EXCEPTION 'INVALID_VISIBILITY' 
              USING HINT = 'must be one of: public, members';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF NOT v_group.is_active THEN RAISE EXCEPTION 'GROUP_INACTIVE'; END IF;

    IF v_group.owner_id = p_caller_user_id THEN
        v_caller_role   := 'owner';
        v_caller_status := 'approved';
        v_is_host       := true;
    ELSE
        SELECT role, status INTO v_caller_role, v_caller_status
          FROM commander_home_members
         WHERE group_id = p_group_id
           AND user_id = p_caller_user_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'NOT_A_MEMBER';
        END IF;
        IF v_caller_status = 'banned' THEN
            RAISE EXCEPTION 'BANNED';
        END IF;
        IF v_caller_status <> 'approved' THEN
            RAISE EXCEPTION 'MEMBERSHIP_NOT_APPROVED';
        END IF;
        v_is_host := (v_caller_role = 'admin');
    END IF;

    -- Host-only actions
    IF p_is_pinned AND NOT v_is_host THEN
        RAISE EXCEPTION 'PIN_REQUIRES_HOST';
    END IF;
    IF p_visible_to = 'public' AND NOT v_is_host THEN
        RAISE EXCEPTION 'PUBLIC_VISIBILITY_REQUIRES_HOST';
    END IF;

    INSERT INTO commander_home_posts (
        group_id, author_id, content, post_type,
        image_urls, video_url, is_pinned, is_published, visible_to
    ) VALUES (
        p_group_id, p_caller_user_id, trim(p_content), p_post_type,
        p_image_urls, p_video_url, p_is_pinned, true, p_visible_to
    )
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'success', true,
        'post_id', v_new_id,
        'group_id', p_group_id,
        'post_type', p_post_type,
        'visible_to', p_visible_to,
        'is_pinned', p_is_pinned
    );
END;
$fn$;
