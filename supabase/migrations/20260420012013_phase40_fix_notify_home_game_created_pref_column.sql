-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420012013 "phase40_fix_notify_home_game_created_pref_column"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 98bdc0646f07ce1be0c089b7f248dd47 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 36: fn_notify_home_game_created uses the wrong preference
-- column name. Real column on user_notification_preferences is
-- 'home_game_new_game_posted' (found via information_schema), but the trigger
-- passes 'home_game_notify_new_games' which does not exist. Consequence:
-- fn_emit_home_notification's defensive wrapper catches the undefined_column
-- and defaults to opt-in. Users who toggled this preference OFF still receive
-- new-game notifications.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_notify_home_game_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_group RECORD; v_recipient RECORD; v_slug text;
BEGIN
    SELECT * INTO v_group FROM commander_home_groups WHERE id = NEW.group_id;
    SELECT sp.slug INTO v_slug FROM social_pages sp
     WHERE sp.linked_entity_type='home_group' AND sp.linked_entity_id = NEW.group_id::text LIMIT 1;

    -- Notify approved members (respecting preference)
    FOR v_recipient IN
        SELECT m.user_id
          FROM commander_home_members m
         WHERE m.group_id = NEW.group_id
           AND m.status = 'approved'
           AND m.user_id <> NEW.host_id
           AND COALESCE(m.notify_new_games, true) = true
    LOOP
        PERFORM public.fn_emit_home_notification(
            v_recipient.user_id, 'home_game_new',
            'New game scheduled in ' || v_group.name,
            COALESCE(NEW.title, 'Home game') || ' on ' || to_char(NEW.scheduled_date, 'Dy Mon DD'),
            '/hub/home-games/' || COALESCE(v_slug, NEW.group_id::text) || '/games/' || NEW.id::text,
            jsonb_build_object('game_id', NEW.id, 'group_id', NEW.group_id),
            'home_game_new_game_posted'   -- was 'home_game_notify_new_games' (nonexistent)
        );
    END LOOP;

    -- Notify followers (non-members who opted in)
    FOR v_recipient IN
        SELECT f.user_id
          FROM commander_home_group_follows f
         WHERE f.group_id = NEW.group_id
           AND f.notify_new_games = true
           AND f.user_id <> NEW.host_id
           AND NOT EXISTS (SELECT 1 FROM commander_home_members m
                            WHERE m.group_id = NEW.group_id AND m.user_id = f.user_id)
    LOOP
        PERFORM public.fn_emit_home_notification(
            v_recipient.user_id, 'home_game_new_followed',
            v_group.name || ' has a new game',
            COALESCE(NEW.title, 'Home game') || ' on ' || to_char(NEW.scheduled_date, 'Dy Mon DD'),
            '/hub/home-games/' || COALESCE(v_slug, NEW.group_id::text) || '/games/' || NEW.id::text,
            jsonb_build_object('game_id', NEW.id, 'group_id', NEW.group_id, 'via', 'follow'),
            NULL  -- follower opt-in is in commander_home_group_follows.notify_new_games
        );
    END LOOP;

    RETURN NEW;
END;
$function$;
