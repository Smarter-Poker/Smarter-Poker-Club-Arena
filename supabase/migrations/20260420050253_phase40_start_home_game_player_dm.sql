-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420050253 "phase40_start_home_game_player_dm"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4b4bbffab453d9a049dfe60c7e1614df of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Feature: click-to-DM from game manage / seating UI
--
-- Single-call RPC for the frontend:
--   host clicks player row → start_home_game_player_dm(...) → navigate to chat
--   player clicks host row → same function, roles reversed
--   seated player clicks another seated player at the same game → same function
--
-- Authorization model:
--   1. Caller must be p_from_user_id (unless service_role)
--   2. Both users must be approved members of the same home group
--   3. Neither user may be banned in that group
--   4. At least one of the two must have a live relationship to THIS game:
--        - host of the game, OR
--        - yes-RSVP for the game, OR
--        - holds a seat for the game (seat status != empty)
--      Scoping to "game context" prevents the click-to-DM UI from becoming a
--      free member-directory harvesting tool for stalkers.
--
-- If p_initial_message is provided, seeds the conversation with it (atomic).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.start_home_game_player_dm(
    p_game_id uuid,
    p_from_user_id uuid,
    p_to_user_id uuid,
    p_initial_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $fn$
DECLARE
    v_caller uuid := auth.uid();
    v_role text := auth.role();
    v_group_id uuid;
    v_game_host uuid;
    v_from_member record;
    v_to_member record;
    v_from_in_game boolean;
    v_to_in_game boolean;
    v_conv jsonb;
    v_conv_id uuid;
    v_msg jsonb;
    v_trim text;
BEGIN
    -- 1. Input sanity
    IF p_game_id IS NULL OR p_from_user_id IS NULL OR p_to_user_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'MISSING_PARAMS');
    END IF;

    IF p_from_user_id = p_to_user_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'SELF_DM');
    END IF;

    -- 2. Auth: caller must match p_from_user_id (service_role bypasses)
    IF v_role <> 'service_role' THEN
      IF v_caller IS NULL OR v_caller <> p_from_user_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'AUTH_MISMATCH');
      END IF;
    END IF;

    -- 3. Look up game + host
    SELECT group_id, host_id
      INTO v_group_id, v_game_host
      FROM commander_home_games
     WHERE id = p_game_id;

    IF v_group_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'GAME_NOT_FOUND');
    END IF;

    -- 4. Verify both users are approved, non-banned members of this group
    SELECT role, status INTO v_from_member
      FROM commander_home_members
     WHERE group_id = v_group_id AND user_id = p_from_user_id;

    SELECT role, status INTO v_to_member
      FROM commander_home_members
     WHERE group_id = v_group_id AND user_id = p_to_user_id;

    IF v_from_member IS NULL OR v_from_member.status <> 'approved' THEN
      RETURN jsonb_build_object('success', false, 'error', 'FROM_NOT_APPROVED_MEMBER');
    END IF;

    IF v_to_member IS NULL OR v_to_member.status <> 'approved' THEN
      RETURN jsonb_build_object('success', false, 'error', 'TO_NOT_APPROVED_MEMBER');
    END IF;

    IF v_from_member.status = 'banned' OR v_to_member.status = 'banned' THEN
      RETURN jsonb_build_object('success', false, 'error', 'BANNED');
    END IF;

    -- 5. Require game-context: at least one party must be tied to this game.
    v_from_in_game := (
      v_game_host = p_from_user_id
      OR EXISTS (SELECT 1 FROM commander_home_rsvps
                  WHERE game_id = p_game_id AND user_id = p_from_user_id
                    AND response = 'yes')
      OR EXISTS (SELECT 1 FROM commander_home_seats
                  WHERE game_id = p_game_id AND user_id = p_from_user_id
                    AND status <> 'empty')
    );

    v_to_in_game := (
      v_game_host = p_to_user_id
      OR EXISTS (SELECT 1 FROM commander_home_rsvps
                  WHERE game_id = p_game_id AND user_id = p_to_user_id
                    AND response = 'yes')
      OR EXISTS (SELECT 1 FROM commander_home_seats
                  WHERE game_id = p_game_id AND user_id = p_to_user_id
                    AND status <> 'empty')
    );

    IF NOT (v_from_in_game OR v_to_in_game) THEN
      RETURN jsonb_build_object('success', false, 'error', 'NO_GAME_RELATIONSHIP');
    END IF;

    -- 6. Get or create the 1:1 conversation via existing helper
    v_conv := public.fn_get_or_create_conversation(p_from_user_id, p_to_user_id);
    IF NOT COALESCE((v_conv->>'success')::boolean, false) THEN
      RETURN jsonb_build_object('success', false,
                                'error', 'CONVERSATION_FAILED',
                                'detail', v_conv);
    END IF;
    v_conv_id := (v_conv->>'conversation_id')::uuid;

    -- 7. Seed with initial message if caller provided one
    v_trim := NULLIF(TRIM(COALESCE(p_initial_message, '')), '');
    IF v_trim IS NOT NULL THEN
      IF length(v_trim) > 4000 THEN
        RETURN jsonb_build_object('success', false, 'error', 'MESSAGE_TOO_LONG');
      END IF;
      v_msg := public.fn_send_message(v_conv_id, p_from_user_id, v_trim, 'text');
      IF NOT COALESCE((v_msg->>'success')::boolean, false) THEN
        -- conversation exists but message failed — still useful, tell caller
        RETURN jsonb_build_object(
          'success', true,
          'conversation_id', v_conv_id,
          'created', COALESCE((v_conv->>'created')::boolean, false),
          'message_sent', false,
          'message_error', v_msg
        );
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'conversation_id', v_conv_id,
      'created', COALESCE((v_conv->>'created')::boolean, false),
      'message_sent', v_trim IS NOT NULL,
      'context_game_id', p_game_id
    );
END;
$fn$;

REVOKE ALL ON FUNCTION public.start_home_game_player_dm(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_home_game_player_dm(uuid, uuid, uuid, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.start_home_game_player_dm IS
  'Phase 40: one-call DM opener for the game manage / seating UI. '
  'Verifies caller identity, group-approved-member status on both sides, '
  'and requires at least one party to be host/yes-RSVP/seat-holder of the '
  'specified game so the feature can''t be abused as a free member directory.';
