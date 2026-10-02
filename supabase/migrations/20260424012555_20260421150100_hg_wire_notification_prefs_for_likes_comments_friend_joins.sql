-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424012555 "20260421150100_hg_wire_notification_prefs_for_likes_comments_friend_joins"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 894e9c372b93a97869589abe90cf23db of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Wire the 3 trigger handlers to pass the appropriate p_pref_column
-- so users can mute high-volume home-game notifications.

-- ── fn_notify_home_post_like → respects home_game_post_likes ────
CREATE OR REPLACE FUNCTION public.fn_notify_home_post_like()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_post RECORD; v_liker_name text; v_group RECORD; v_slug text;
BEGIN
    SELECT * INTO v_post FROM commander_home_posts WHERE id = NEW.post_id;
    IF v_post.author_id = NEW.user_id THEN RETURN NEW; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_post.group_id;
    SELECT sp.slug INTO v_slug FROM social_pages sp
     WHERE sp.linked_entity_type = 'home_group' AND sp.linked_entity_id = v_group.id::text LIMIT 1;
    SELECT COALESCE(display_name, full_name, username, 'Someone') INTO v_liker_name
      FROM profiles WHERE id = NEW.user_id;

    PERFORM public.fn_emit_home_notification(
        v_post.author_id, 'home_post_like',
        v_liker_name || ' liked your post',
        'In ' || v_group.name,
        '/hub/home-games/' || COALESCE(v_slug, v_group.id::text),
        jsonb_build_object('post_id', v_post.id, 'liker_id', NEW.user_id),
        'home_game_post_likes'          -- ★ NEW: respect mute pref
    );
    RETURN NEW;
END;
$function$;

-- ── fn_notify_home_post_comment → respects home_game_post_comments ──
CREATE OR REPLACE FUNCTION public.fn_notify_home_post_comment()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_post RECORD; v_commenter_name text; v_group RECORD; v_slug text;
BEGIN
    SELECT * INTO v_post FROM commander_home_posts WHERE id = NEW.post_id;
    IF v_post.author_id = NEW.author_id THEN RETURN NEW; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_post.group_id;
    SELECT sp.slug INTO v_slug FROM social_pages sp
     WHERE sp.linked_entity_type = 'home_group' AND sp.linked_entity_id = v_group.id::text LIMIT 1;
    SELECT COALESCE(display_name, full_name, username, 'Someone') INTO v_commenter_name
      FROM profiles WHERE id = NEW.author_id;

    PERFORM public.fn_emit_home_notification(
        v_post.author_id, 'home_post_comment',
        v_commenter_name || ' commented on your post',
        LEFT(NEW.content, 140),
        '/hub/home-games/' || COALESCE(v_slug, v_group.id::text),
        jsonb_build_object('post_id', v_post.id, 'comment_id', NEW.id, 'commenter_id', NEW.author_id),
        'home_game_post_comments'       -- ★ NEW: respect mute pref
    );
    RETURN NEW;
END;
$function$;

-- ── fn_notify_friends_of_home_join → respects friend_activity ───
CREATE OR REPLACE FUNCTION public.fn_notify_friends_of_home_join()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_group RECORD; v_slug text; v_joiner_name text; v_friend RECORD;
BEGIN
    IF TG_OP = 'INSERT' AND NEW.status <> 'approved' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND (OLD.status = 'approved' OR NEW.status <> 'approved') THEN RETURN NEW; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = NEW.group_id;
    IF v_group.is_private THEN RETURN NEW; END IF;

    SELECT sp.slug INTO v_slug FROM social_pages sp
     WHERE sp.linked_entity_type='home_group' AND sp.linked_entity_id=v_group.id::text LIMIT 1;
    SELECT COALESCE(display_name, full_name, username, 'A friend') INTO v_joiner_name
      FROM profiles WHERE id = NEW.user_id;

    FOR v_friend IN
        SELECT DISTINCT CASE WHEN f.user_id = NEW.user_id THEN f.friend_id ELSE f.user_id END AS friend_user_id
          FROM friendships f
         WHERE (f.user_id = NEW.user_id OR f.friend_id = NEW.user_id)
           AND f.status = 'accepted'
    LOOP
        IF v_friend.friend_user_id = NEW.user_id THEN CONTINUE; END IF;
        IF EXISTS (SELECT 1 FROM commander_home_members
                    WHERE group_id = NEW.group_id AND user_id = v_friend.friend_user_id) THEN
            CONTINUE;
        END IF;

        PERFORM public.fn_emit_home_notification(
            v_friend.friend_user_id, 'home_group_friend_joined',
            v_joiner_name || ' joined ' || v_group.name,
            'Your friend is now in ' || v_group.name || ' — check it out',
            '/hub/home-games/' || COALESCE(v_slug, v_group.id::text),
            jsonb_build_object('group_id', v_group.id, 'friend_id', NEW.user_id),
            'friend_activity'            -- ★ NEW: respect mute pref
        );
    END LOOP;
    RETURN NEW;
END;
$function$;
