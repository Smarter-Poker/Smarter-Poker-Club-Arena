-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419155906 "phase24c2_post_waitlist_checkin_invite_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b7a077411aae6ca6cb9803fdcafe66c7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 24 PART C2 — post/like/comment + waitlist + check-in + invites
-- =========================================================================

-- ────────────────────────────────────────────────────────────────────────
-- P1.5a: edit_home_group_post
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.edit_home_group_post(
    p_post_id         uuid,
    p_caller_user_id  uuid,
    p_content         text,
    p_image_urls      text[] DEFAULT NULL,
    p_is_pinned       boolean DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_post   RECORD;
    v_group  RECORD;
    v_is_host boolean;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_post FROM commander_home_posts WHERE id = p_post_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_post.group_id;

    v_is_host := (v_group.owner_id = p_caller_user_id)
              OR EXISTS (SELECT 1 FROM commander_home_members 
                          WHERE group_id = v_post.group_id AND user_id = p_caller_user_id
                            AND role = 'admin' AND status = 'approved');

    -- Author OR host can edit
    IF v_post.author_id <> p_caller_user_id AND NOT v_is_host THEN
        RAISE EXCEPTION 'NOT_AUTHORIZED';
    END IF;

    IF p_content IS NULL OR length(trim(p_content)) = 0 THEN
        RAISE EXCEPTION 'EMPTY_CONTENT';
    END IF;
    IF length(p_content) > 10000 THEN
        RAISE EXCEPTION 'CONTENT_TOO_LONG';
    END IF;

    -- Only hosts can pin
    IF p_is_pinned IS NOT NULL AND p_is_pinned <> v_post.is_pinned AND NOT v_is_host THEN
        RAISE EXCEPTION 'PIN_REQUIRES_HOST';
    END IF;

    UPDATE commander_home_posts
       SET content     = trim(p_content),
           image_urls  = COALESCE(p_image_urls, image_urls),
           is_pinned   = COALESCE(p_is_pinned, is_pinned),
           updated_at  = NOW()
     WHERE id = p_post_id;

    RETURN jsonb_build_object('success', true, 'post_id', p_post_id);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.edit_home_group_post(uuid, uuid, text, text[], boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.edit_home_group_post(uuid, uuid, text, text[], boolean) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P1.5b: delete_home_group_post
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_home_group_post(
    p_post_id         uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_post   RECORD;
    v_group  RECORD;
    v_is_host boolean;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_post FROM commander_home_posts WHERE id = p_post_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', true, 'already_gone', true); END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_post.group_id;

    v_is_host := (v_group.owner_id = p_caller_user_id)
              OR EXISTS (SELECT 1 FROM commander_home_members 
                          WHERE group_id = v_post.group_id AND user_id = p_caller_user_id
                            AND role = 'admin' AND status = 'approved');

    IF v_post.author_id <> p_caller_user_id AND NOT v_is_host THEN
        RAISE EXCEPTION 'NOT_AUTHORIZED';
    END IF;

    DELETE FROM commander_home_posts WHERE id = p_post_id;

    IF v_is_host AND v_post.author_id <> p_caller_user_id THEN
        INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
        VALUES (v_post.group_id, p_caller_user_id, 'post', p_post_id, 'moderated_delete',
                jsonb_build_object('original_author', v_post.author_id));
    END IF;

    RETURN jsonb_build_object('success', true, 'post_id', p_post_id);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.delete_home_group_post(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.delete_home_group_post(uuid, uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P1.5c: toggle_home_post_like
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.toggle_home_post_like(
    p_post_id         uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_post        RECORD;
    v_group       RECORD;
    v_existing_id uuid;
    v_action      text;
    v_new_count   int;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_post FROM commander_home_posts WHERE id = p_post_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_post.group_id;

    -- Must be able to see the post: public group, owner, or approved member
    IF v_group.is_private 
       AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = v_post.group_id AND user_id = p_caller_user_id 
                          AND status = 'approved')
    THEN
        RAISE EXCEPTION 'NOT_AUTHORIZED';
    END IF;

    -- Toggle
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
$fn$;

REVOKE EXECUTE ON FUNCTION public.toggle_home_post_like(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.toggle_home_post_like(uuid, uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P1.5d: create_home_post_comment
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_home_post_comment(
    p_post_id         uuid,
    p_caller_user_id  uuid,
    p_content         text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_post     RECORD;
    v_group    RECORD;
    v_new_id   uuid;
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
$fn$;

REVOKE EXECUTE ON FUNCTION public.create_home_post_comment(uuid, uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_home_post_comment(uuid, uuid, text) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P1.6: promote_home_game_waitlist  (manual + auto-trigger companion)
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.promote_home_game_waitlist(
    p_game_id         uuid,
    p_caller_user_id  uuid DEFAULT NULL  -- NULL when invoked by trigger
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_game         RECORD;
    v_group        RECORD;
    v_seats_open   int;
    v_promoted_ids uuid[] := ARRAY[]::uuid[];
    v_rsvp         RECORD;
BEGIN
    -- If caller is provided, verify they're a host. If not, assume trigger context.
    IF p_caller_user_id IS NOT NULL THEN
        IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
            RAISE EXCEPTION 'UNAUTHORIZED';
        END IF;
    END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    IF v_game.status NOT IN ('scheduled','confirmed') THEN
        RAISE EXCEPTION 'GAME_NOT_OPEN';
    END IF;

    -- Authorization check if caller is a user (not trigger)
    IF p_caller_user_id IS NOT NULL THEN
        SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;
        IF v_game.host_id <> p_caller_user_id 
           AND v_group.owner_id <> p_caller_user_id
           AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                            WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                              AND role = 'admin' AND status = 'approved')
        THEN
            RAISE EXCEPTION 'NOT_AUTHORIZED';
        END IF;
    END IF;

    -- Compute open seats
    v_seats_open := GREATEST(0, COALESCE(v_game.max_players, 9) - COALESCE(v_game.rsvp_yes, 0));
    IF v_seats_open = 0 THEN
        RETURN jsonb_build_object('success', true, 'promoted_count', 0, 'seats_full', true);
    END IF;

    -- Promote oldest-first from waitlist up to seats_open
    FOR v_rsvp IN 
        SELECT id, user_id FROM commander_home_rsvps
         WHERE game_id = p_game_id
           AND response = 'waitlist'
         ORDER BY responded_at
         LIMIT v_seats_open
    LOOP
        UPDATE commander_home_rsvps 
           SET response = 'yes', updated_at = NOW()
         WHERE id = v_rsvp.id;
        v_promoted_ids := array_append(v_promoted_ids, v_rsvp.user_id);
    END LOOP;

    -- Trigger recalculates counts automatically. Return summary.
    RETURN jsonb_build_object(
        'success', true,
        'promoted_count', array_length(v_promoted_ids, 1),
        'promoted_user_ids', v_promoted_ids
    );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.promote_home_game_waitlist(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.promote_home_game_waitlist(uuid, uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P1.6b: auto-promote trigger — when someone flips yes → no/maybe, 
-- check if a seat opens and auto-promote from waitlist
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_auto_promote_waitlist()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
    -- Only care about transitions where a 'yes' is leaving or count drops
    IF TG_OP = 'UPDATE' AND OLD.response = 'yes' AND NEW.response <> 'yes' THEN
        PERFORM public.promote_home_game_waitlist(NEW.game_id, NULL);
    ELSIF TG_OP = 'DELETE' AND OLD.response = 'yes' THEN
        PERFORM public.promote_home_game_waitlist(OLD.game_id, NULL);
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$fn$;

-- Fire AFTER the count trigger so rsvp_yes is already updated
CREATE TRIGGER trg_auto_promote_waitlist
    AFTER UPDATE OR DELETE ON commander_home_rsvps
    FOR EACH ROW 
    EXECUTE FUNCTION public.fn_auto_promote_waitlist();

-- ────────────────────────────────────────────────────────────────────────
-- P1.9: checkin_to_home_game
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.checkin_to_home_game(
    p_game_id         uuid,
    p_member_user_id  uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_game  RECORD;
    v_group RECORD;
    v_rsvp  RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    -- Only host/owner/admin can mark check-ins
    IF v_game.host_id <> p_caller_user_id 
       AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                          AND role = 'admin' AND status = 'approved')
    THEN
        RAISE EXCEPTION 'NOT_AUTHORIZED';
    END IF;

    SELECT * INTO v_rsvp FROM commander_home_rsvps 
     WHERE game_id = p_game_id AND user_id = p_member_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NO_RSVP' USING HINT = 'member has no RSVP for this game';
    END IF;

    UPDATE commander_home_rsvps
       SET checked_in_at = COALESCE(checked_in_at, NOW()),
           checked_in_by = p_caller_user_id,
           flaked        = false,
           updated_at    = NOW()
     WHERE id = v_rsvp.id;

    RETURN jsonb_build_object(
        'success', true, 
        'rsvp_id', v_rsvp.id, 
        'member_user_id', p_member_user_id,
        'checked_in_at', NOW()
    );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.checkin_to_home_game(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.checkin_to_home_game(uuid, uuid, uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P1.8: create_home_group_invite_token
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_home_group_invite_token(
    p_group_id         uuid,
    p_caller_user_id   uuid,
    p_max_uses         int DEFAULT NULL,
    p_expires_at       timestamptz DEFAULT NULL,
    p_label            text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_group    RECORD;
    v_is_host  boolean;
    v_token    text;
    v_new_id   uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF NOT v_group.is_active THEN RAISE EXCEPTION 'GROUP_INACTIVE'; END IF;

    v_is_host := (v_group.owner_id = p_caller_user_id)
              OR EXISTS (SELECT 1 FROM commander_home_members 
                          WHERE group_id = p_group_id AND user_id = p_caller_user_id
                            AND role = 'admin' AND status = 'approved');
    IF NOT v_is_host THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    -- Generate unique token: 12 chars, base64-ish, case-insensitive-friendly
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
        'success', true,
        'token_id', v_new_id,
        'token', v_token,
        'share_url_hint', '/hub/home-games/join/' || v_token
    );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.create_home_group_invite_token(uuid, uuid, int, timestamptz, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_home_group_invite_token(uuid, uuid, int, timestamptz, text) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P1.8b: redeem_home_group_invite_token (fetch + validate + auto-join)
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.redeem_home_group_invite_token(
    p_token            text,
    p_caller_user_id   uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_token  RECORD;
    v_join   jsonb;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_token FROM commander_home_invite_tokens 
     WHERE token = p_token AND is_active = true;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_TOKEN'; END IF;
    IF v_token.expires_at IS NOT NULL AND v_token.expires_at < NOW() THEN
        RAISE EXCEPTION 'TOKEN_EXPIRED';
    END IF;
    IF v_token.max_uses IS NOT NULL AND v_token.use_count >= v_token.max_uses THEN
        RAISE EXCEPTION 'TOKEN_EXHAUSTED';
    END IF;

    -- Reuse join_home_group RPC with the token as invite_code equivalent
    -- (but pass through the already-validated private group bypass via service_role)
    v_join := public.join_home_group(v_token.group_id, p_caller_user_id, NULL);

    -- If join succeeded (not already a member), increment use_count
    IF (v_join->>'success')::boolean AND NOT COALESCE((v_join->>'already_member')::boolean, false)
       AND NOT COALESCE((v_join->>'already_pending')::boolean, false)
    THEN
        UPDATE commander_home_invite_tokens
           SET use_count    = use_count + 1,
               last_used_at = NOW()
         WHERE id = v_token.id;
    END IF;

    RETURN v_join || jsonb_build_object('via_token', v_token.id, 'group_id', v_token.group_id);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.redeem_home_group_invite_token(text, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.redeem_home_group_invite_token(text, uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P1.8c: track_home_group_share_click (anon-callable; ups share_click_count)
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.track_home_group_share_click(
    p_group_id uuid,
    p_token_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
    UPDATE commander_home_groups 
       SET share_click_count = share_click_count + 1
     WHERE id = p_group_id;

    IF p_token_id IS NOT NULL THEN
        UPDATE commander_home_invite_tokens
           SET click_count = click_count + 1
         WHERE id = p_token_id AND group_id = p_group_id;
    END IF;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.track_home_group_share_click(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.track_home_group_share_click(uuid, uuid) TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P3.5b: track_home_group_view (anon-callable; ups view_count)
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.track_home_group_view(p_group_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
    UPDATE commander_home_groups SET view_count = view_count + 1 WHERE id = p_group_id;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.track_home_group_view(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.track_home_group_view(uuid) TO anon, authenticated, service_role;
