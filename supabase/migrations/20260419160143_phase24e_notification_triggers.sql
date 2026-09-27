-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419160143 "phase24e_notification_triggers"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b1793c62d1212b2f79f3c1ef4e93336a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 24 PART E — Notification plumbing
--  -----------------------------------------------------------------------
--  Writes rows into public.notifications for every home-game event so the
--  existing notification UI + push infrastructure picks them up.
--
--  Notification shape (existing table):
--    user_id, type, title, message, link, data (jsonb), read, created_at
--
--  Respects user_notification_preferences opt-outs where applicable.
-- =========================================================================

-- ────────────────────────────────────────────────────────────────────────
-- Helper: insert a notification, honoring user_notification_preferences
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_emit_home_notification(
    p_user_id      uuid,
    p_type         text,
    p_title        text,
    p_message      text,
    p_link         text,
    p_data         jsonb,
    p_pref_column  text DEFAULT NULL  -- e.g. 'home_game_reminders'
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_allowed boolean := true;
    v_pref_val text;
BEGIN
    IF p_user_id IS NULL THEN RETURN; END IF;

    -- Check user pref if column name provided; default allow if row missing
    IF p_pref_column IS NOT NULL THEN
        EXECUTE format('SELECT (%I)::text FROM user_notification_preferences WHERE user_id = $1', p_pref_column)
             INTO v_pref_val
            USING p_user_id;
        IF v_pref_val = 'false' THEN v_allowed := false; END IF;
    END IF;

    IF v_allowed THEN
        INSERT INTO notifications (user_id, type, title, message, link, data, read)
        VALUES (p_user_id, p_type, p_title, p_message, p_link, COALESCE(p_data, '{}'::jsonb), false);
    END IF;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.fn_emit_home_notification(uuid, text, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
-- internal-only; called from triggers

-- ────────────────────────────────────────────────────────────────────────
-- P4.1 + P4.3: RSVP notifies host; pending join notifies host
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_notify_home_rsvp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_game    RECORD;
    v_group   RECORD;
    v_rsvper  RECORD;
    v_slug    text;
    v_is_new  boolean;
BEGIN
    -- Only fire on INSERT or when response actually changes on UPDATE
    IF TG_OP = 'UPDATE' AND OLD.response = NEW.response THEN RETURN NEW; END IF;

    v_is_new := (TG_OP = 'INSERT');

    SELECT * INTO v_game FROM commander_home_games WHERE id = NEW.game_id;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;
    SELECT p.id, COALESCE(p.display_name, p.full_name, p.username, 'Someone') AS display_name, p.avatar_url
      INTO v_rsvper FROM profiles p WHERE p.id = NEW.user_id;
    SELECT sp.slug INTO v_slug FROM social_pages sp 
     WHERE sp.linked_entity_type = 'home_group' AND sp.linked_entity_id = v_group.id::text LIMIT 1;

    -- Notify game host (and group owner if different) when RSVP lands
    PERFORM public.fn_emit_home_notification(
        v_game.host_id,
        'home_game_rsvp',
        v_rsvper.display_name || ' RSVP''d ' || NEW.response,
        COALESCE(v_game.title, 'Your home game') || ' — ' || v_rsvper.display_name || 
            CASE NEW.response 
              WHEN 'yes' THEN ' is in' 
              WHEN 'maybe' THEN ' might make it' 
              WHEN 'no' THEN ' can''t make it' 
              WHEN 'waitlist' THEN ' joined the waitlist' 
              ELSE ' updated RSVP' END,
        '/hub/home-games/' || COALESCE(v_slug, v_group.id::text) || '/host',
        jsonb_build_object(
            'game_id', v_game.id, 'group_id', v_group.id,
            'rsvper_id', NEW.user_id, 'response', NEW.response,
            'is_new', v_is_new
        ),
        'home_game_host_requests'
    );

    IF v_group.owner_id IS NOT NULL AND v_group.owner_id <> v_game.host_id THEN
        PERFORM public.fn_emit_home_notification(
            v_group.owner_id, 'home_game_rsvp',
            v_rsvper.display_name || ' RSVP''d ' || NEW.response,
            COALESCE(v_game.title, 'Home game') || ' — ' || NEW.response,
            '/hub/home-games/' || COALESCE(v_slug, v_group.id::text) || '/host',
            jsonb_build_object('game_id', v_game.id, 'rsvper_id', NEW.user_id, 'response', NEW.response),
            'home_game_host_requests'
        );
    END IF;

    -- Also notify the RSVPer: confirmation back to them
    IF v_is_new AND NEW.response = 'yes' THEN
        PERFORM public.fn_emit_home_notification(
            NEW.user_id, 'home_game_rsvp_confirmed',
            'You''re in!',
            'You''re confirmed for ' || COALESCE(v_game.title, 'the home game') || 
                ' on ' || v_game.scheduled_date::text,
            '/hub/home-games/' || COALESCE(v_slug, v_group.id::text),
            jsonb_build_object('game_id', v_game.id),
            'home_game_rsvp_confirmations'
        );
    END IF;

    RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_notify_home_rsvp
    AFTER INSERT OR UPDATE OF response ON commander_home_rsvps
    FOR EACH ROW EXECUTE FUNCTION public.fn_notify_home_rsvp();

-- ────────────────────────────────────────────────────────────────────────
-- P4.2 + P4.3: member status changes — notify target + host
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_notify_home_member_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_group RECORD;
    v_slug  text;
    v_member_name text;
BEGIN
    SELECT * INTO v_group FROM commander_home_groups WHERE id = COALESCE(NEW.group_id, OLD.group_id);
    SELECT sp.slug INTO v_slug FROM social_pages sp 
     WHERE sp.linked_entity_type = 'home_group' AND sp.linked_entity_id = v_group.id::text LIMIT 1;
    SELECT COALESCE(display_name, full_name, username, 'New member') INTO v_member_name
      FROM profiles WHERE id = COALESCE(NEW.user_id, OLD.user_id);

    -- NEW pending request — notify host + admins
    IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
        PERFORM public.fn_emit_home_notification(
            v_group.owner_id, 'home_group_pending_request',
            v_member_name || ' wants to join',
            v_member_name || ' requested to join ' || v_group.name,
            '/hub/home-games/' || COALESCE(v_slug, v_group.id::text) || '/host',
            jsonb_build_object('group_id', v_group.id, 'user_id', NEW.user_id),
            'home_game_host_requests'
        );

    -- Status changed to approved — notify member
    ELSIF TG_OP = 'UPDATE' AND OLD.status <> 'approved' AND NEW.status = 'approved' THEN
        PERFORM public.fn_emit_home_notification(
            NEW.user_id, 'home_group_approved',
            'Welcome to ' || v_group.name,
            'You''re now a member of ' || v_group.name,
            '/hub/home-games/' || COALESCE(v_slug, v_group.id::text),
            jsonb_build_object('group_id', v_group.id),
            NULL  -- always notify on approval
        );

    -- Status changed to declined — notify member
    ELSIF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status = 'declined' THEN
        PERFORM public.fn_emit_home_notification(
            NEW.user_id, 'home_group_declined',
            'Request update',
            'Your request to join ' || v_group.name || ' was not approved',
            '/hub/home-games',
            jsonb_build_object('group_id', v_group.id),
            NULL
        );

    -- Status changed to banned — notify member
    ELSIF TG_OP = 'UPDATE' AND OLD.status <> 'banned' AND NEW.status = 'banned' THEN
        PERFORM public.fn_emit_home_notification(
            NEW.user_id, 'home_group_banned',
            'Removed from ' || v_group.name,
            'You''ve been removed from ' || v_group.name,
            '/hub/home-games',
            jsonb_build_object('group_id', v_group.id),
            NULL
        );

    -- Promoted to admin
    ELSIF TG_OP = 'UPDATE' AND OLD.role = 'member' AND NEW.role = 'admin' THEN
        PERFORM public.fn_emit_home_notification(
            NEW.user_id, 'home_group_promoted',
            'You''re now an admin of ' || v_group.name,
            'You now have admin privileges in ' || v_group.name,
            '/hub/home-games/' || COALESCE(v_slug, v_group.id::text) || '/host',
            jsonb_build_object('group_id', v_group.id, 'new_role', 'admin'),
            NULL
        );
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$fn$;

CREATE TRIGGER trg_notify_home_member_status
    AFTER INSERT OR UPDATE ON commander_home_members
    FOR EACH ROW EXECUTE FUNCTION public.fn_notify_home_member_status();

-- ────────────────────────────────────────────────────────────────────────
-- P4.4: New game scheduled — notify approved members
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_notify_home_game_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_group RECORD;
    v_slug  text;
    v_member RECORD;
BEGIN
    -- Only notify on INSERT with status that makes the game visible
    IF NEW.status NOT IN ('scheduled','confirmed') THEN RETURN NEW; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = NEW.group_id;
    SELECT sp.slug INTO v_slug FROM social_pages sp 
     WHERE sp.linked_entity_type = 'home_group' AND sp.linked_entity_id = v_group.id::text LIMIT 1;

    FOR v_member IN 
        SELECT user_id FROM commander_home_members 
         WHERE group_id = NEW.group_id 
           AND status = 'approved'
           AND COALESCE(notify_new_games, true) = true
           -- Don't notify the creator
           AND user_id <> NEW.host_id
    LOOP
        PERFORM public.fn_emit_home_notification(
            v_member.user_id, 'home_game_scheduled',
            'New game: ' || COALESCE(NEW.title, v_group.name),
            COALESCE(NEW.title, 'New home game') || ' — ' || NEW.scheduled_date::text || 
                COALESCE(' at ' || NEW.start_time::text, ''),
            '/hub/home-games/' || COALESCE(v_slug, v_group.id::text),
            jsonb_build_object(
                'game_id', NEW.id, 'group_id', v_group.id,
                'scheduled_date', NEW.scheduled_date, 'start_time', NEW.start_time
            ),
            'home_game_new_game_posted'
        );
    END LOOP;

    RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_notify_home_game_created
    AFTER INSERT ON commander_home_games
    FOR EACH ROW EXECUTE FUNCTION public.fn_notify_home_game_created();

-- ────────────────────────────────────────────────────────────────────────
-- P4.5: New announcement post — notify approved members (respecting prefs)
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_notify_home_post_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_group RECORD;
    v_slug  text;
    v_member RECORD;
    v_author_name text;
BEGIN
    IF NEW.post_type <> 'announcement' THEN RETURN NEW; END IF;
    IF COALESCE(NEW.is_published, true) = false THEN RETURN NEW; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = NEW.group_id;
    SELECT sp.slug INTO v_slug FROM social_pages sp 
     WHERE sp.linked_entity_type = 'home_group' AND sp.linked_entity_id = v_group.id::text LIMIT 1;
    SELECT COALESCE(display_name, full_name, username, 'A host') INTO v_author_name
      FROM profiles WHERE id = NEW.author_id;

    FOR v_member IN 
        SELECT user_id FROM commander_home_members 
         WHERE group_id = NEW.group_id 
           AND status = 'approved'
           AND COALESCE(notify_announcements, true) = true
           AND user_id <> NEW.author_id
    LOOP
        PERFORM public.fn_emit_home_notification(
            v_member.user_id, 'home_group_announcement',
            v_group.name || ' — ' || v_author_name,
            LEFT(NEW.content, 140),
            '/hub/home-games/' || COALESCE(v_slug, v_group.id::text),
            jsonb_build_object('post_id', NEW.id, 'group_id', v_group.id),
            'home_game_announcements'
        );
    END LOOP;

    RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_notify_home_post_created
    AFTER INSERT ON commander_home_posts
    FOR EACH ROW EXECUTE FUNCTION public.fn_notify_home_post_created();

-- ────────────────────────────────────────────────────────────────────────
-- P4.6: Game cancellation — notify all RSVP'd users
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_notify_home_game_cancelled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_group RECORD;
    v_slug  text;
    v_rsvper RECORD;
BEGIN
    -- Only on status change TO cancelled
    IF OLD.status = 'cancelled' OR NEW.status <> 'cancelled' THEN RETURN NEW; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = NEW.group_id;
    SELECT sp.slug INTO v_slug FROM social_pages sp 
     WHERE sp.linked_entity_type = 'home_group' AND sp.linked_entity_id = v_group.id::text LIMIT 1;

    FOR v_rsvper IN 
        SELECT DISTINCT user_id FROM commander_home_rsvps 
         WHERE game_id = NEW.id 
           AND response IN ('yes','maybe','waitlist')
    LOOP
        PERFORM public.fn_emit_home_notification(
            v_rsvper.user_id, 'home_game_cancelled',
            'Game cancelled: ' || COALESCE(NEW.title, v_group.name),
            COALESCE(NEW.title, 'The game') || ' on ' || NEW.scheduled_date::text || 
                ' has been cancelled' || 
                CASE WHEN NEW.cancellation_reason IS NOT NULL 
                     THEN ' — ' || NEW.cancellation_reason ELSE '' END,
            '/hub/home-games/' || COALESCE(v_slug, v_group.id::text),
            jsonb_build_object(
                'game_id', NEW.id, 'group_id', v_group.id,
                'reason', NEW.cancellation_reason
            ),
            'home_game_cancellations'
        );
    END LOOP;

    RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_notify_home_game_cancelled
    AFTER UPDATE OF status ON commander_home_games
    FOR EACH ROW EXECUTE FUNCTION public.fn_notify_home_game_cancelled();

-- ────────────────────────────────────────────────────────────────────────
-- BONUS: Post like + comment notifies post author (single-target, cheap)
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_notify_home_post_like()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_post RECORD;
    v_liker_name text;
    v_group RECORD;
    v_slug text;
BEGIN
    SELECT * INTO v_post FROM commander_home_posts WHERE id = NEW.post_id;
    IF v_post.author_id = NEW.user_id THEN RETURN NEW; END IF;  -- don't self-notify
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
        NULL
    );
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_notify_home_post_like
    AFTER INSERT ON commander_home_post_likes
    FOR EACH ROW EXECUTE FUNCTION public.fn_notify_home_post_like();

CREATE OR REPLACE FUNCTION public.fn_notify_home_post_comment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_post RECORD;
    v_commenter_name text;
    v_group RECORD;
    v_slug text;
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
        NULL
    );
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_notify_home_post_comment
    AFTER INSERT ON commander_home_post_comments
    FOR EACH ROW EXECUTE FUNCTION public.fn_notify_home_post_comment();
