-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419161243 "phase24g_diamonds_messenger_unread_ratelimits_ical_v4"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ff97299e5bdf65f9c23b56a7c2e4a6a9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Part G v4 — with home_group category now allowed

-- ═══ P6.7 Diamond host reward ═══
CREATE OR REPLACE FUNCTION public.fn_grant_host_diamonds_on_complete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_attended int := 0; v_reward int := 50; v_host_id uuid; v_group RECORD;
BEGIN
    IF OLD.status = 'completed' OR NEW.status <> 'completed' THEN RETURN NEW; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = NEW.group_id;
    v_host_id := COALESCE(NEW.host_id, v_group.owner_id);
    IF v_host_id IS NULL THEN RETURN NEW; END IF;

    SELECT COUNT(*) INTO v_attended FROM commander_home_rsvps 
     WHERE game_id = NEW.id AND checked_in_at IS NOT NULL;
    v_reward := LEAST(100, 50 + 5 * v_attended);

    PERFORM public.award_diamonds(v_host_id, v_reward, 'home_games',
        jsonb_build_object('kind','home_game_host_reward','game_id', NEW.id,
                           'group_id', NEW.group_id, 'attendees', v_attended,
                           'game_title', COALESCE(NEW.title, 'home game'),
                           'scheduled_date', NEW.scheduled_date));

    PERFORM public.fn_emit_home_notification(v_host_id, 'home_game_host_rewarded',
        'You earned ' || v_reward || ' diamonds',
        'Thanks for hosting ' || COALESCE(NEW.title, v_group.name),
        '/hub/diamonds',
        jsonb_build_object('game_id', NEW.id, 'amount', v_reward, 'attendees', v_attended), NULL);

    INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (NEW.group_id, NULL, 'game', NEW.id, 'host_rewarded',
            jsonb_build_object('host_user_id', v_host_id, 'diamonds', v_reward, 'attendees', v_attended));
    RETURN NEW;
END; $fn$;

DROP TRIGGER IF EXISTS trg_grant_host_diamonds_on_complete ON commander_home_games;
CREATE TRIGGER trg_grant_host_diamonds_on_complete
    AFTER UPDATE OF status ON commander_home_games
    FOR EACH ROW EXECUTE FUNCTION public.fn_grant_host_diamonds_on_complete();

-- ═══ P4.10 Auto-messenger thread ═══
ALTER TABLE commander_home_groups
    ADD COLUMN IF NOT EXISTS messenger_conversation_id uuid;
CREATE INDEX IF NOT EXISTS idx_home_groups_conv ON commander_home_groups(messenger_conversation_id);

CREATE OR REPLACE FUNCTION public.fn_create_home_group_conversation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_conv_id uuid;
BEGIN
    INSERT INTO conversations (participant_ids, created_by, category, is_pinned, is_read_only)
    VALUES (ARRAY[NEW.owner_id]::uuid[], NEW.owner_id, 'home_group', false, false)
    RETURNING id INTO v_conv_id;
    UPDATE commander_home_groups SET messenger_conversation_id = v_conv_id WHERE id = NEW.id;
    INSERT INTO messenger_participants (conversation_id, user_id, role, joined_at)
    VALUES (v_conv_id, NEW.owner_id, 'admin', NOW()) ON CONFLICT DO NOTHING;
    RETURN NEW;
END; $fn$;

DROP TRIGGER IF EXISTS trg_create_home_group_conversation ON commander_home_groups;
CREATE TRIGGER trg_create_home_group_conversation
    AFTER INSERT ON commander_home_groups
    FOR EACH ROW EXECUTE FUNCTION public.fn_create_home_group_conversation();

CREATE OR REPLACE FUNCTION public.fn_add_member_to_group_conversation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_conv_id uuid; v_current_ids uuid[];
BEGIN
    IF TG_OP = 'INSERT' AND NEW.status <> 'approved' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND (OLD.status = 'approved' OR NEW.status <> 'approved') THEN RETURN NEW; END IF;
    SELECT messenger_conversation_id INTO v_conv_id FROM commander_home_groups WHERE id = NEW.group_id;
    IF v_conv_id IS NULL THEN RETURN NEW; END IF;
    INSERT INTO messenger_participants (conversation_id, user_id, role, joined_at)
    VALUES (v_conv_id, NEW.user_id, CASE WHEN NEW.role IN ('owner','admin') THEN 'admin' ELSE 'member' END, NOW())
    ON CONFLICT DO NOTHING;
    SELECT participant_ids INTO v_current_ids FROM conversations WHERE id = v_conv_id;
    IF NOT (NEW.user_id = ANY(v_current_ids)) THEN
        UPDATE conversations SET participant_ids = array_append(participant_ids, NEW.user_id), updated_at = NOW() WHERE id = v_conv_id;
    END IF;
    RETURN NEW;
END; $fn$;

DROP TRIGGER IF EXISTS trg_add_member_to_group_conversation ON commander_home_members;
CREATE TRIGGER trg_add_member_to_group_conversation
    AFTER INSERT OR UPDATE OF status ON commander_home_members
    FOR EACH ROW EXECUTE FUNCTION public.fn_add_member_to_group_conversation();

CREATE OR REPLACE FUNCTION public.fn_remove_member_from_group_conversation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_conv_id uuid; v_user_id uuid; v_group_id uuid;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status = 'banned' AND OLD.status <> 'banned' THEN
        v_user_id := NEW.user_id; v_group_id := NEW.group_id;
    ELSIF TG_OP = 'DELETE' THEN
        v_user_id := OLD.user_id; v_group_id := OLD.group_id;
    ELSE RETURN COALESCE(NEW, OLD);
    END IF;
    SELECT messenger_conversation_id INTO v_conv_id FROM commander_home_groups WHERE id = v_group_id;
    IF v_conv_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
    DELETE FROM messenger_participants WHERE conversation_id = v_conv_id AND user_id = v_user_id;
    UPDATE conversations SET participant_ids = array_remove(participant_ids, v_user_id), updated_at = NOW() WHERE id = v_conv_id;
    RETURN COALESCE(NEW, OLD);
END; $fn$;

DROP TRIGGER IF EXISTS trg_remove_member_from_group_conversation ON commander_home_members;
CREATE TRIGGER trg_remove_member_from_group_conversation
    AFTER UPDATE OR DELETE ON commander_home_members
    FOR EACH ROW EXECUTE FUNCTION public.fn_remove_member_from_group_conversation();

-- Backfill legacy
DO $bk$
DECLARE v_group RECORD; v_conv_id uuid; v_member RECORD; v_user_ids uuid[];
BEGIN
    FOR v_group IN SELECT * FROM commander_home_groups WHERE messenger_conversation_id IS NULL LOOP
        SELECT array_agg(user_id) INTO v_user_ids FROM commander_home_members WHERE group_id = v_group.id AND status = 'approved';
        IF v_user_ids IS NULL THEN v_user_ids := ARRAY[v_group.owner_id]::uuid[]; END IF;
        INSERT INTO conversations (participant_ids, created_by, category, is_pinned, is_read_only)
        VALUES (v_user_ids, v_group.owner_id, 'home_group', false, false)
        RETURNING id INTO v_conv_id;
        UPDATE commander_home_groups SET messenger_conversation_id = v_conv_id WHERE id = v_group.id;
        FOR v_member IN SELECT user_id, role FROM commander_home_members WHERE group_id = v_group.id AND status = 'approved' LOOP
            INSERT INTO messenger_participants (conversation_id, user_id, role, joined_at)
            VALUES (v_conv_id, v_member.user_id, CASE WHEN v_member.role IN ('owner','admin') THEN 'admin' ELSE 'member' END, NOW())
            ON CONFLICT DO NOTHING;
        END LOOP;
    END LOOP;
END; $bk$;

-- ═══ P7.5 Unread ═══
ALTER TABLE commander_home_members ADD COLUMN IF NOT EXISTS last_read_posts_at timestamptz;

CREATE OR REPLACE FUNCTION public.mark_home_group_posts_read(p_group_id uuid, p_caller_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    UPDATE commander_home_members SET last_read_posts_at = NOW() WHERE group_id = p_group_id AND user_id = p_caller_user_id;
    RETURN jsonb_build_object('success', true);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.mark_home_group_posts_read(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_home_group_posts_read(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_home_group_unread_count(p_group_id uuid, p_caller_user_id uuid)
RETURNS int LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_last_read timestamptz; v_count int;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT last_read_posts_at INTO v_last_read FROM commander_home_members 
     WHERE group_id = p_group_id AND user_id = p_caller_user_id AND status = 'approved';
    IF NOT FOUND THEN RETURN 0; END IF;
    SELECT COUNT(*) INTO v_count FROM commander_home_posts 
     WHERE group_id = p_group_id AND created_at > COALESCE(v_last_read, '1970-01-01'::timestamptz) AND author_id <> p_caller_user_id;
    RETURN COALESCE(v_count, 0);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.get_home_group_unread_count(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_home_group_unread_count(uuid, uuid) TO authenticated, service_role;

-- ═══ P8.5 Rate limit ═══
CREATE OR REPLACE FUNCTION public.fn_check_home_rate_limit(p_caller_user_id uuid, p_action text, p_window_minutes int DEFAULT 60)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_count int := 0; v_limit int; v_since timestamptz := NOW() - (p_window_minutes || ' minutes')::interval;
BEGIN
    CASE p_action
        WHEN 'join' THEN v_limit := 20; SELECT COUNT(*) INTO v_count FROM commander_home_members WHERE user_id = p_caller_user_id AND created_at > v_since;
        WHEN 'post' THEN v_limit := 30; SELECT COUNT(*) INTO v_count FROM commander_home_posts WHERE author_id = p_caller_user_id AND created_at > v_since;
        WHEN 'comment' THEN v_limit := 60; SELECT COUNT(*) INTO v_count FROM commander_home_post_comments WHERE author_id = p_caller_user_id AND created_at > v_since;
        WHEN 'invite_token' THEN v_limit := 15; SELECT COUNT(*) INTO v_count FROM commander_home_invite_tokens WHERE created_by = p_caller_user_id AND created_at > v_since;
        WHEN 'rsvp' THEN v_limit := 40; SELECT COUNT(*) INTO v_count FROM commander_home_rsvps WHERE user_id = p_caller_user_id AND responded_at > v_since;
        ELSE RETURN true;
    END CASE;
    RETURN (v_count < v_limit);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.fn_check_home_rate_limit(uuid, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_check_home_rate_limit(uuid, text, int) TO authenticated, service_role;

-- ═══ P6.9 iCal ═══
CREATE OR REPLACE FUNCTION public.generate_home_group_ical(p_group_id uuid, p_days_ahead int DEFAULT 90)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_ics text := ''; v_game RECORD; v_group RECORD;
    v_dtstamp text := to_char(NOW() AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"');
BEGIN
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RETURN ''; END IF;
    IF v_group.is_private 
       AND (auth.uid() IS NULL OR (auth.uid() <> v_group.owner_id
            AND NOT EXISTS (SELECT 1 FROM commander_home_members WHERE group_id = p_group_id AND user_id = auth.uid() AND status = 'approved')))
    THEN RETURN ''; END IF;

    v_ics := 'BEGIN:VCALENDAR' || chr(13)||chr(10) ||
             'VERSION:2.0' || chr(13)||chr(10) ||
             'PRODID:-//Smarter.Poker//Home Games//EN' || chr(13)||chr(10) ||
             'CALSCALE:GREGORIAN' || chr(13)||chr(10) ||
             'X-WR-CALNAME:' || replace(v_group.name, ',', '\,') || chr(13)||chr(10);

    FOR v_game IN SELECT * FROM commander_home_games 
         WHERE group_id = p_group_id AND status IN ('scheduled','confirmed','in_progress')
           AND scheduled_date BETWEEN CURRENT_DATE AND CURRENT_DATE + (p_days_ahead || ' days')::interval
         ORDER BY scheduled_date
    LOOP
        v_ics := v_ics 
            || 'BEGIN:VEVENT' || chr(13)||chr(10)
            || 'UID:' || v_game.id::text || '@smarter.poker' || chr(13)||chr(10)
            || 'DTSTAMP:' || v_dtstamp || chr(13)||chr(10)
            || 'DTSTART:' || to_char(v_game.scheduled_date + COALESCE(v_game.start_time, TIME '19:00'), 'YYYYMMDD"T"HH24MISS') || chr(13)||chr(10)
            || 'DTEND:' || to_char(v_game.scheduled_date + COALESCE(v_game.end_time, TIME '23:00') + CASE WHEN v_game.end_time < TIME '06:00' THEN INTERVAL '1 day' ELSE INTERVAL '0' END, 'YYYYMMDD"T"HH24MISS') || chr(13)||chr(10)
            || 'SUMMARY:' || replace(COALESCE(v_game.title, v_group.name), ',', '\,') || chr(13)||chr(10)
            || 'DESCRIPTION:' || replace(COALESCE(v_game.description, 'Home poker game'), ',', '\,') || ' Stakes: ' || COALESCE(v_game.stakes, 'TBD') || chr(13)||chr(10)
            || 'LOCATION:' || replace(COALESCE(v_game.address, v_group.city || ', ' || v_group.state), ',', '\,') || chr(13)||chr(10)
            || 'STATUS:' || CASE v_game.status WHEN 'confirmed' THEN 'CONFIRMED' WHEN 'cancelled' THEN 'CANCELLED' ELSE 'TENTATIVE' END || chr(13)||chr(10)
            || 'END:VEVENT' || chr(13)||chr(10);
    END LOOP;
    v_ics := v_ics || 'END:VCALENDAR' || chr(13)||chr(10);
    RETURN v_ics;
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.generate_home_group_ical(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_home_group_ical(uuid, int) TO anon, authenticated, service_role;
