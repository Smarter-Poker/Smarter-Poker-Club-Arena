-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420045948 "rsvp_converts_to_dm_after_game_starts"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 65edc923d89ffae3823c749473addc5b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Product change — Dan: "After the game starts, the RSVP should convert to a
-- direct message to the game host through the social media messenger."
--
-- Behavior:
--   - Before scheduled_date + start_time: RSVP records normally (yes/no/maybe/
--     waitlist). No change.
--   - At or after scheduled_date + start_time (while game is still scheduled/
--     confirmed/in_progress, or cron has flipped it to completed): RSVP is
--     NOT recorded. Instead the function returns a soft-failure payload
--     carrying the host's profile and a ready-to-open social_conversations
--     thread. Frontend uses this to swap the RSVP button for "Message host".
--
-- Order of checks (important):
--   1. auth / validation / game-exists
--   2. status check (cancelled games are still hard-rejected — no point
--      creating a DM for "join this cancelled game")
--   3. group / ban / membership (banned users and non-members of private
--      groups never get a DM deep link; they hit their usual errors)
--   4. GAME_STARTED check (soft return with DM info) — reached only by users
--      who were otherwise allowed to RSVP
--   5. guest policy
--   6. INSERT
--
-- Timezone convention: follows fn_home_game_auto_complete — treats
-- scheduled_date + start_time as UTC-naive. Caller is responsible for storing
-- start_time in UTC. (Broader timezone architecture is a separate concern.)
--
-- API shape: the GAME_STARTED branch is a soft failure (success:false, error:
-- 'GAME_STARTED') consistent with bug #29's join_home_group shape, because
-- the frontend needs the extra fields (host, conversation_id, dm_url) to
-- route the user rather than just show a toast.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rsvp_to_home_game(
    p_game_id          uuid,
    p_response         text,
    p_caller_user_id   uuid,
    p_bringing_guests  integer DEFAULT 0,
    p_message          text    DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_game         RECORD;
    v_group        RECORD;
    v_host_profile RECORD;
    v_is_member    boolean := false;
    v_is_banned    boolean := false;
    v_rsvp_id      uuid;
    v_updated_game RECORD;
    v_game_start_ts timestamp;
    v_dm_result    jsonb;
    v_conv_id      uuid;
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

    -- Cancelled games are a hard error — DM-to-host doesn't apply.
    IF v_game.status = 'cancelled' THEN
        RAISE EXCEPTION 'GAME_NOT_OPEN_FOR_RSVP'
              USING HINT = 'game status is cancelled';
    END IF;

    -- Unknown / non-RSVPable statuses (draft, etc.) — treat as closed.
    IF v_game.status NOT IN ('scheduled','confirmed','in_progress','completed') THEN
        RAISE EXCEPTION 'GAME_NOT_OPEN_FOR_RSVP'
              USING HINT = 'game status is ' || COALESCE(v_game.status,'NULL');
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

    -- ========================================================================
    -- NEW BEHAVIOR: if the game has started, RSVP converts to a DM to the host
    -- ========================================================================
    v_game_start_ts := v_game.scheduled_date + v_game.start_time;

    IF v_game.status = 'completed'
       OR v_game.status = 'in_progress'
       OR v_game_start_ts <= NOW()
    THEN
        -- Host cannot message themselves. If the caller is the host, just
        -- fall through with a distinct error — no RSVP, no DM.
        IF p_caller_user_id = v_game.host_id THEN
            RAISE EXCEPTION 'HOST_CANNOT_RSVP_TO_OWN_GAME';
        END IF;

        -- Find or create a direct conversation between caller and host.
        v_dm_result := public.fn_get_or_create_conversation(
            p_caller_user_id, v_game.host_id, 'direct'
        );

        IF COALESCE((v_dm_result->>'success')::boolean, false) THEN
            v_conv_id := (v_dm_result->>'conversation_id')::uuid;
        ELSE
            v_conv_id := NULL;  -- DM creation failed; frontend falls back
        END IF;

        -- Pull host profile for UI rendering
        SELECT p.id, p.username, p.display_name, p.full_name, p.avatar_url
          INTO v_host_profile
          FROM profiles p
         WHERE p.id = v_game.host_id;

        RETURN jsonb_build_object(
            'success',         false,
            'error',           'GAME_STARTED',
            'message',         'This game has already started. '
                            || 'Message the host directly.',
            'game', jsonb_build_object(
                'id',             v_game.id,
                'scheduled_date', v_game.scheduled_date,
                'start_time',     v_game.start_time,
                'status',         v_game.status
            ),
            'host', jsonb_build_object(
                'id',           v_host_profile.id,
                'username',     v_host_profile.username,
                'display_name', COALESCE(
                                  v_host_profile.display_name,
                                  v_host_profile.full_name,
                                  v_host_profile.username),
                'avatar_url',   v_host_profile.avatar_url
            ),
            'conversation_id', v_conv_id,
            'dm_url',          CASE
                                 WHEN v_conv_id IS NOT NULL
                                   THEN '/hub/messenger/' || v_conv_id::text
                                 ELSE NULL
                               END
        );
    END IF;

    -- ========================================================================
    -- Normal RSVP path (game in the future)
    -- ========================================================================
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
        'success',  true,
        'rsvp_id',  v_rsvp_id,
        'game_id',  p_game_id,
        'response', p_response,
        'counts',   jsonb_build_object(
            'yes',      v_updated_game.rsvp_yes,
            'maybe',    v_updated_game.rsvp_maybe,
            'no',       v_updated_game.rsvp_no,
            'waitlist', v_updated_game.waitlist_count
        )
    );
END;
$fn$;

COMMENT ON FUNCTION public.rsvp_to_home_game IS
  'RSVP to a home game. After the scheduled start time (or once status moves '
  'to in_progress/completed), the function returns {success:false, '
  'error:GAME_STARTED, host, conversation_id, dm_url} so the frontend can '
  'route the user to a DM thread with the host instead of recording a stale '
  'RSVP. Consistent with bug #29 join_home_group shape.';
