-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424005340 "20260421121000_hg_rate_limit_high_risk_write_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 bc733091cf646c1300baff0cb93a66cd of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Commercial-grade hardening: rate-limit the 5 highest-abuse-risk HG
-- write RPCs to block spam / bot behavior. Each gate uses the existing
-- fn_try_consume_home_rate_limit (advisory-lock + sliding window). On
-- quota exhaustion, callers see RATE_LIMIT_EXCEEDED and the function
-- exits before doing any DB write.
--
-- Quotas are tuned for normal human usage (+generous headroom) while
-- putting an absolute ceiling that blocks script abuse.

-- ── 1. create_home_group_post (15/hr) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.create_home_group_post(
  p_group_id uuid, p_caller_user_id uuid, p_content text,
  p_post_type text DEFAULT 'update'::text,
  p_image_urls text[] DEFAULT NULL::text[],
  p_video_url text DEFAULT NULL::text,
  p_is_pinned boolean DEFAULT false,
  p_visible_to text DEFAULT 'members'::text
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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

    -- Rate limit: 15 posts / 60 min per user
    IF NOT public.fn_try_consume_home_rate_limit(
         p_caller_user_id, 'home_post_create', 15, 60) THEN
      RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED'
            USING HINT = 'post creation: 15 per 60 min.';
    END IF;

    IF p_content IS NULL OR length(trim(p_content)) = 0 THEN
        RAISE EXCEPTION 'EMPTY_CONTENT'; END IF;
    IF length(p_content) > 10000 THEN
        RAISE EXCEPTION 'CONTENT_TOO_LONG'; END IF;
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
         WHERE group_id = p_group_id AND user_id = p_caller_user_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;
        IF v_caller_status = 'banned'   THEN RAISE EXCEPTION 'BANNED'; END IF;
        IF v_caller_status <> 'approved' THEN RAISE EXCEPTION 'MEMBERSHIP_NOT_APPROVED'; END IF;
        v_is_host := (v_caller_role = 'admin');
    END IF;

    IF p_is_pinned AND NOT v_is_host THEN RAISE EXCEPTION 'PIN_REQUIRES_HOST'; END IF;
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
$function$;

-- ── 2. create_home_post_comment (60/hr) ───────────────────────────
CREATE OR REPLACE FUNCTION public.create_home_post_comment(
  p_post_id uuid, p_caller_user_id uuid, p_content text
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_post      RECORD;
    v_group     RECORD;
    v_new_id    uuid;
    v_is_banned boolean;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    IF NOT public.fn_try_consume_home_rate_limit(
         p_caller_user_id, 'home_comment_create', 60, 60) THEN
      RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED'
            USING HINT = 'comment creation: 60 per 60 min.';
    END IF;

    IF p_content IS NULL OR length(trim(p_content)) = 0 THEN
        RAISE EXCEPTION 'EMPTY_CONTENT'; END IF;
    IF length(p_content) > 2000 THEN
        RAISE EXCEPTION 'CONTENT_TOO_LONG'; END IF;

    SELECT * INTO v_post FROM commander_home_posts WHERE id = p_post_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_post.group_id;

    SELECT EXISTS (
      SELECT 1 FROM commander_home_members
       WHERE group_id = v_post.group_id AND user_id = p_caller_user_id AND status = 'banned'
    ) INTO v_is_banned;
    IF v_is_banned THEN RAISE EXCEPTION 'BANNED'; END IF;

    IF v_group.is_private
       AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members
                        WHERE group_id = v_post.group_id AND user_id = p_caller_user_id
                          AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;

    INSERT INTO commander_home_post_comments (post_id, author_id, content)
    VALUES (p_post_id, p_caller_user_id, trim(p_content))
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object('success', true, 'comment_id', v_new_id);
END;
$function$;

-- ── 3. create_home_group_invite_token (20/hr) ─────────────────────
CREATE OR REPLACE FUNCTION public.create_home_group_invite_token(
  p_group_id uuid, p_caller_user_id uuid,
  p_max_uses integer DEFAULT NULL::integer,
  p_expires_at timestamptz DEFAULT NULL::timestamptz,
  p_label text DEFAULT NULL::text
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_group    RECORD;
    v_is_host  boolean;
    v_token    text;
    v_new_id   uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    IF NOT public.fn_try_consume_home_rate_limit(
         p_caller_user_id, 'home_invite_token_create', 20, 60) THEN
      RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED'
            USING HINT = 'invite tokens: 20 per 60 min.';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF NOT v_group.is_active THEN RAISE EXCEPTION 'GROUP_INACTIVE'; END IF;

    v_is_host := (v_group.owner_id = p_caller_user_id)
              OR EXISTS (SELECT 1 FROM commander_home_members
                          WHERE group_id = p_group_id AND user_id = p_caller_user_id
                            AND role = 'admin' AND status = 'approved');
    IF NOT v_is_host THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    LOOP
        v_token := upper(substr(translate(encode(gen_random_bytes(10), 'base64'), '+/=0O1IL', ''), 1, 12));
        EXIT WHEN NOT EXISTS (SELECT 1 FROM commander_home_invite_tokens WHERE token = v_token);
    END LOOP;

    INSERT INTO commander_home_invite_tokens
        (group_id, created_by, token, max_uses, expires_at, label)
    VALUES
        (p_group_id, p_caller_user_id, v_token, p_max_uses, p_expires_at, p_label)
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'success', true, 'token_id', v_new_id, 'token', v_token,
        'share_url_hint', '/hub/home-games/join/' || v_token
    );
END;
$function$;

-- ── 4. record_home_game_photo (40/hr) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.record_home_game_photo(
  p_game_id uuid, p_caller_user_id uuid, p_photo_url text, p_caption text DEFAULT NULL::text
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_game  RECORD;
    v_group RECORD;
    v_new_id uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    IF NOT public.fn_try_consume_home_rate_limit(
         p_caller_user_id, 'home_game_photo_upload', 40, 60) THEN
      RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED'
            USING HINT = 'photo uploads: 40 per 60 min.';
    END IF;

    IF p_photo_url IS NULL OR length(trim(p_photo_url)) = 0 THEN
        RAISE EXCEPTION 'MISSING_URL';
    END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    IF v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members
                        WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                          AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;

    INSERT INTO commander_home_game_photos (game_id, uploader_id, photo_url, caption)
    VALUES (p_game_id, p_caller_user_id, p_photo_url, p_caption)
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object('success', true, 'photo_id', v_new_id);
END;
$function$;

-- ── 5. toggle_home_post_like (200/hr) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.toggle_home_post_like(
  p_post_id uuid, p_caller_user_id uuid
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
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

    IF NOT public.fn_try_consume_home_rate_limit(
         p_caller_user_id, 'home_post_like_toggle', 200, 60) THEN
      RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED'
            USING HINT = 'like/unlike: 200 per 60 min.';
    END IF;

    SELECT * INTO v_post FROM commander_home_posts WHERE id = p_post_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_post.group_id;

    SELECT EXISTS (
      SELECT 1 FROM commander_home_members
       WHERE group_id = v_post.group_id AND user_id = p_caller_user_id AND status = 'banned'
    ) INTO v_is_banned;
    IF v_is_banned THEN RAISE EXCEPTION 'BANNED'; END IF;

    IF v_group.is_private
       AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members
                        WHERE group_id = v_post.group_id AND user_id = p_caller_user_id
                          AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;

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
