-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420012605 "phase40_fix_broadcast_operator_precedence"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1117285f1c155ef9213c569cddf8b6aa of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 37: broadcast_to_home_game_rsvps has an AND/OR precedence bug.
--
-- The recipient cursor is:
--   SELECT ... WHERE game_id = X
--                AND response IN ('yes')
--                 OR (p_include_maybe AND response = 'maybe')
--
-- SQL binds AND tighter than OR, so this parses as:
--   (game_id=X AND response='yes') OR (p_include_maybe AND response='maybe')
--
-- When a host calls with p_include_maybe=true, the second disjunct selects
-- every user who ever RSVP'd 'maybe' to ANY home game across the entire
-- platform. Broadcast message goes out cross-group to unrelated users.
--
-- Fix: parenthesize to keep game_id scoped.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.broadcast_to_home_game_rsvps(
  p_game_id uuid, p_message text, p_caller_user_id uuid,
  p_include_maybe boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_game RECORD; v_group RECORD; v_slug text;
    v_recipient RECORD; v_sent int := 0;
    v_title text;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
      RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;
    IF p_message IS NULL OR length(trim(p_message)) = 0 THEN
      RAISE EXCEPTION 'EMPTY_MESSAGE';
    END IF;
    IF length(p_message) > 1000 THEN RAISE EXCEPTION 'MESSAGE_TOO_LONG'; END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    IF v_game.host_id <> p_caller_user_id AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members
                        WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                          AND role = 'admin' AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;

    SELECT sp.slug INTO v_slug FROM social_pages sp
     WHERE sp.linked_entity_type='home_group' AND sp.linked_entity_id=v_group.id::text LIMIT 1;

    v_title := 'Host message: ' || COALESCE(v_game.title, v_group.name);

    -- Fixed precedence: game_id filter now applies to both response branches.
    FOR v_recipient IN
        SELECT DISTINCT user_id FROM commander_home_rsvps
         WHERE game_id = p_game_id
           AND ( response = 'yes'
                 OR (p_include_maybe AND response = 'maybe') )
    LOOP
        PERFORM public.fn_emit_home_notification(
            v_recipient.user_id,
            'home_game_host_broadcast',
            v_title,
            LEFT(p_message, 500),
            '/hub/home-games/' || COALESCE(v_slug, v_group.id::text),
            jsonb_build_object('game_id', p_game_id, 'from_host', p_caller_user_id, 'full_message', p_message),
            NULL
        );
        v_sent := v_sent + 1;
    END LOOP;

    INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (v_group.id, p_caller_user_id, 'game', p_game_id, 'host_broadcast',
            jsonb_build_object('recipients', v_sent, 'preview', LEFT(p_message, 100)));

    RETURN jsonb_build_object('success', true, 'recipients_count', v_sent);
END;
$function$;

COMMENT ON FUNCTION public.broadcast_to_home_game_rsvps IS
  'Phase 40: fixed AND/OR precedence that caused p_include_maybe=true to '
  'broadcast to every ''maybe''-RSVPer platform-wide instead of just this game.';
