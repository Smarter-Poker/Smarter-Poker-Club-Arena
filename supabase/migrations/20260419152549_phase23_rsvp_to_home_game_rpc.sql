-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419152549 "phase23_rsvp_to_home_game_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1794a9d2d44ff46c6a1b7cd0c439c8e7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 23 — rsvp_to_home_game RPC
--  -----------------------------------------------------------------------
--  User-facing RSVP action. Enforces:
--    1. Auth: p_caller_user_id must match auth.uid() (no RSVP-for-others)
--    2. Game must be in 'scheduled' or 'confirmed' status
--    3. Game's scheduled_date must be >= today
--    4. For private groups: caller must be an approved member
--    5. For public groups: allow any authenticated user to RSVP
--    6. response must be one of: yes, maybe, no, waitlist
--
--  Returns the upserted RSVP row + updated game counts.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.rsvp_to_home_game(
    p_game_id          uuid,
    p_response         text,
    p_caller_user_id   uuid,
    p_bringing_guests  int  DEFAULT 0,
    p_message          text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_game         RECORD;
    v_group        RECORD;
    v_is_member    boolean := false;
    v_rsvp_id      uuid;
    v_updated_game RECORD;
BEGIN
    -- Phase 22 identity guard
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED' 
              USING HINT = 'rsvp_to_home_game requires auth.uid() = p_caller_user_id';
    END IF;

    -- Validate response
    IF p_response NOT IN ('yes','maybe','no','waitlist') THEN
        RAISE EXCEPTION 'INVALID_RESPONSE' 
              USING HINT = 'response must be one of: yes, maybe, no, waitlist';
    END IF;

    -- Guest count sanity
    IF p_bringing_guests IS NULL OR p_bringing_guests < 0 THEN
        p_bringing_guests := 0;
    END IF;

    -- Load game
    SELECT * INTO v_game 
      FROM commander_home_games 
     WHERE id = p_game_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'GAME_NOT_FOUND';
    END IF;

    IF v_game.status NOT IN ('scheduled','confirmed') THEN
        RAISE EXCEPTION 'GAME_NOT_OPEN_FOR_RSVP'
              USING HINT = 'game status is ' || v_game.status;
    END IF;

    IF v_game.scheduled_date < CURRENT_DATE THEN
        RAISE EXCEPTION 'GAME_IN_THE_PAST';
    END IF;

    -- Load parent group
    SELECT * INTO v_group
      FROM commander_home_groups
     WHERE id = v_game.group_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'GROUP_NOT_FOUND';
    END IF;

    -- Membership check — owner counts as member
    SELECT EXISTS (
        SELECT 1 FROM commander_home_groups WHERE id = v_game.group_id AND owner_id = p_caller_user_id
    ) OR EXISTS (
        SELECT 1 FROM commander_home_members
         WHERE group_id = v_game.group_id 
           AND user_id = p_caller_user_id 
           AND status = 'approved'
    ) INTO v_is_member;

    -- Private groups require membership; public allows open RSVP
    IF v_group.is_private AND NOT v_is_member THEN
        RAISE EXCEPTION 'NOT_A_MEMBER' 
              USING HINT = 'private group RSVP requires approved membership';
    END IF;

    -- Guest limits
    IF NOT v_game.allow_guests AND p_bringing_guests > 0 THEN
        RAISE EXCEPTION 'GUESTS_NOT_ALLOWED';
    END IF;

    IF v_game.allow_guests 
       AND v_game.guest_limit IS NOT NULL 
       AND p_bringing_guests > v_game.guest_limit THEN
        RAISE EXCEPTION 'GUEST_LIMIT_EXCEEDED' 
              USING HINT = 'maximum ' || v_game.guest_limit || ' guests per player';
    END IF;

    -- Upsert the RSVP
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

    -- Trigger on commander_home_rsvps already recomputes game counters.
    -- Read them back to return in response.
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
$fn$;

-- Clean ACL — authenticated + service_role only (no anon)
REVOKE EXECUTE ON FUNCTION public.rsvp_to_home_game(uuid, text, uuid, int, text) 
    FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rsvp_to_home_game(uuid, text, uuid, int, text)
    TO authenticated, service_role;

COMMENT ON FUNCTION public.rsvp_to_home_game(uuid, text, uuid, int, text) IS
  'Phase 23: User-facing RSVP action for home games. Enforces auth.uid()=caller, membership for private groups, valid game status, valid response value, guest limits. Upserts the RSVP and returns updated counts.';
