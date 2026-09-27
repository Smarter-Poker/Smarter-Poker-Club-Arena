-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420020014 "phase40_block_banned_from_rsvp"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 01428cf92b426e7a3c6ac3b5540d1727 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 44: rsvp_to_home_game lets banned users of PUBLIC groups
-- RSVP. Same bug class as #43 — the membership check short-circuits for
-- public groups, but an explicit banned row is ignored.
--
-- Fix: raise BANNED if the caller has a banned membership row in this
-- group's members table, regardless of the group's privacy.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rsvp_to_home_game(
  p_game_id uuid, p_response text, p_caller_user_id uuid,
  p_bringing_guests integer DEFAULT 0, p_message text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_game         RECORD;
    v_group        RECORD;
    v_is_member    boolean := false;
    v_is_banned    boolean := false;
    v_rsvp_id      uuid;
    v_updated_game RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED'
              USING HINT = 'rsvp_to_home_game requires auth.uid() = p_caller_user_id';
    END IF;

    IF p_response NOT IN ('yes','maybe','no','waitlist') THEN
        RAISE EXCEPTION 'INVALID_RESPONSE'
              USING HINT = 'response must be one of: yes, maybe, no, waitlist';
    END IF;

    IF p_bringing_guests IS NULL OR p_bringing_guests < 0 THEN
        p_bringing_guests := 0;
    END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;

    IF v_game.status NOT IN ('scheduled','confirmed') THEN
        RAISE EXCEPTION 'GAME_NOT_OPEN_FOR_RSVP'
              USING HINT = 'game status is ' || v_game.status;
    END IF;

    IF v_game.scheduled_date < CURRENT_DATE THEN
        RAISE EXCEPTION 'GAME_IN_THE_PAST';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

    -- Phase 40 Bug 44: explicit banned check regardless of group privacy
    SELECT EXISTS (
      SELECT 1 FROM commander_home_members
       WHERE group_id = v_game.group_id
         AND user_id = p_caller_user_id
         AND status = 'banned'
    ) INTO v_is_banned;
    IF v_is_banned THEN
      RAISE EXCEPTION 'BANNED';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM commander_home_groups
         WHERE id = v_game.group_id AND owner_id = p_caller_user_id
    ) OR EXISTS (
        SELECT 1 FROM commander_home_members
         WHERE group_id = v_game.group_id
           AND user_id = p_caller_user_id
           AND status = 'approved'
    ) INTO v_is_member;

    IF v_group.is_private AND NOT v_is_member THEN
        RAISE EXCEPTION 'NOT_A_MEMBER'
              USING HINT = 'private group RSVP requires approved membership';
    END IF;

    IF NOT v_game.allow_guests AND p_bringing_guests > 0 THEN
        RAISE EXCEPTION 'GUESTS_NOT_ALLOWED';
    END IF;

    IF v_game.allow_guests
       AND v_game.guest_limit IS NOT NULL
       AND p_bringing_guests > v_game.guest_limit THEN
        RAISE EXCEPTION 'GUEST_LIMIT_EXCEEDED'
              USING HINT = 'maximum ' || v_game.guest_limit || ' guests per player';
    END IF;

    INSERT INTO commander_home_rsvps AS r
        (game_id, user_id, response, bringing_guests, message, responded_at, updated_at)
    VALUES
        (p_game_id, p_caller_user_id, p_response, p_bringing_guests, p_message, NOW(), NOW())
    ON CONFLICT (game_id, user_id) DO UPDATE
        SET response        = EXCLUDED.response,
            bringing_guests = EXCLUDED.bringing_guests,
            message         = EXCLUDED.message,
            updated_at      = NOW()
    RETURNING id INTO v_rsvp_id;

    SELECT id, rsvp_yes, rsvp_maybe, rsvp_no, waitlist_count
      INTO v_updated_game
      FROM commander_home_games
     WHERE id = p_game_id;

    RETURN jsonb_build_object(
        'success', true,
        'rsvp_id', v_rsvp_id,
        'game_id', p_game_id,
        'response', p_response,
        'counts', jsonb_build_object(
            'yes',      v_updated_game.rsvp_yes,
            'maybe',    v_updated_game.rsvp_maybe,
            'no',       v_updated_game.rsvp_no,
            'waitlist', v_updated_game.waitlist_count
        )
    );
END;
$function$;

COMMENT ON FUNCTION public.rsvp_to_home_game IS
  'Phase 40 Bug 44: explicit BANNED check. Banned users of public groups can '
  'no longer RSVP to games; same shape as Bug 43 fix for comments/likes.';
