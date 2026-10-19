-- 20261019093626_late_home_game_rsvp_opens_a_plain_direct_message.sql
--
-- A LATE HOME GAME RSVP OPENS A PLAIN DIRECT MESSAGE (2026-10-19)
--
-- WHAT WAS BROKEN, READ FROM PRODUCTION
--
-- public.rsvp_to_home_game answers an RSVP that arrives after the game has
-- started (status in_progress/completed, or start time passed) with
-- 'GAME_STARTED' and a link to message the host directly. To make that link
-- it called
--
--     public.fn_get_or_create_conversation(p_caller_user_id, v_game.host_id, 'direct')
--
-- Production has exactly two overloads: (uuid, uuid) and
-- (uuid, uuid, p_context_entity_id uuid, p_context_entity_type text DEFAULT NULL).
-- A three-argument call can only resolve to the four-argument one, so 'direct'
-- was cast to p_context_entity_id uuid and raised 22P02 "invalid input syntax
-- for type uuid". Nothing caught it, so every player who RSVPed to a game that
-- had already started got an error instead of the "message the host" reply.
--
-- THE FIX. The reply says "Message the host directly", and the function reads
-- back only conversation_id: a plain one-to-one direct conversation with no
-- context entity. That is the two-argument overload, which finds an existing
-- direct thread between the two players (context_entity_id IS NULL) before
-- creating one, and applies the same auth.uid() = p_user_id rule this
-- function already enforces on p_caller_user_id. The call now passes
-- (p_caller_user_id, v_game.host_id). Every other byte is production's body
-- (md5 of pg_get_functiondef read 2026-10-19 = ccdb5bceeb0eefec3532a83acdfb97cc);
-- grants are restated as production holds them.
-- Pinned by tests/a-late-home-game-rsvp-opens-a-plain-direct-message.law.test.ts.
--
-- @live-proof: md5(pg_get_functiondef('public.rsvp_to_home_game(uuid,text,uuid,integer,text)'::regprocedure)) = '50f4569d647404253e60a71b4a8b31cc'

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preimage$
DECLARE v_md5 text;
BEGIN
  v_md5 := md5(pg_get_functiondef('public.rsvp_to_home_game(uuid,text,uuid,integer,text)'::regprocedure));
  IF v_md5 IS DISTINCT FROM 'ccdb5bceeb0eefec3532a83acdfb97cc'
     AND v_md5 IS DISTINCT FROM '50f4569d647404253e60a71b4a8b31cc' THEN
    RAISE EXCEPTION 'RSVP_DIRECT_MESSAGE_PREIMAGE_CHANGED: %', v_md5;
  END IF;
  IF to_regprocedure('public.fn_get_or_create_conversation(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'RSVP_DIRECT_MESSAGE_TWO_ARGUMENT_OVERLOAD_MISSING';
  END IF;
END
$preimage$;

CREATE OR REPLACE FUNCTION public.rsvp_to_home_game(p_game_id uuid, p_response text, p_caller_user_id uuid, p_bringing_guests integer DEFAULT 0, p_message text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_game RECORD; v_group RECORD; v_host_profile RECORD;
    v_is_member boolean := false; v_is_banned boolean := false;
    v_rsvp_id uuid; v_updated_game RECORD;
    v_game_start_ts timestamptz; v_effective_tz text;
    v_dm_result jsonb; v_conv_id uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED'
              USING HINT = 'rsvp_to_home_game requires auth.uid() = p_caller_user_id';
    END IF;
    IF p_response NOT IN ('yes','maybe','no','waitlist') THEN
        RAISE EXCEPTION 'INVALID_RESPONSE'
              USING HINT = 'response must be one of: yes, maybe, no, waitlist';
    END IF;
    IF p_message IS NOT NULL AND length(p_message) > 500 THEN
        RAISE EXCEPTION 'MESSAGE_TOO_LONG' USING HINT = 'max 500 chars';
    END IF;
    IF p_bringing_guests IS NULL OR p_bringing_guests < 0 THEN p_bringing_guests := 0; END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    IF v_game.status = 'cancelled' THEN
      RAISE EXCEPTION 'GAME_NOT_OPEN_FOR_RSVP' USING HINT = 'game status is cancelled';
    END IF;
    IF v_game.status NOT IN ('scheduled','confirmed','in_progress','completed') THEN
        RAISE EXCEPTION 'GAME_NOT_OPEN_FOR_RSVP'
              USING HINT = 'game status is ' || COALESCE(v_game.status,'NULL');
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

    SELECT EXISTS (SELECT 1 FROM commander_home_members
       WHERE group_id = v_game.group_id AND user_id = p_caller_user_id AND status = 'banned')
     INTO v_is_banned;
    IF v_is_banned THEN RAISE EXCEPTION 'BANNED'; END IF;

    SELECT EXISTS (SELECT 1 FROM commander_home_groups
         WHERE id = v_game.group_id AND owner_id = p_caller_user_id)
    OR EXISTS (SELECT 1 FROM commander_home_members
         WHERE group_id = v_game.group_id AND user_id = p_caller_user_id AND status = 'approved')
     INTO v_is_member;

    IF v_group.is_private AND NOT v_is_member THEN
        RAISE EXCEPTION 'NOT_A_MEMBER'
              USING HINT = 'private group RSVP requires approved membership';
    END IF;

    v_effective_tz := COALESCE(
                        NULLIF(v_game.timezone, ''),
                        NULLIF(v_group.timezone, ''),
                        'America/New_York');
    v_game_start_ts := (v_game.scheduled_date + v_game.start_time) AT TIME ZONE v_effective_tz;

    IF v_game.status = 'completed' OR v_game.status = 'in_progress'
       OR v_game_start_ts <= NOW()
    THEN
        IF p_caller_user_id = v_game.host_id THEN
            RAISE EXCEPTION 'HOST_CANNOT_RSVP_TO_OWN_GAME';
        END IF;
        v_dm_result := public.fn_get_or_create_conversation(
            p_caller_user_id, v_game.host_id);
        IF COALESCE((v_dm_result->>'success')::boolean, false) THEN
            v_conv_id := (v_dm_result->>'conversation_id')::uuid;
        ELSE v_conv_id := NULL; END IF;

        SELECT p.id, p.username, p.display_name, p.avatar_url
          INTO v_host_profile FROM profiles p WHERE p.id = v_game.host_id;

        RETURN jsonb_build_object(
            'success', false, 'error', 'GAME_STARTED',
            'message', 'This game has already started. Message the host directly.',
            'game', jsonb_build_object(
                'id', v_game.id, 'scheduled_date', v_game.scheduled_date,
                'start_time', v_game.start_time, 'timezone', v_effective_tz,
                'status', v_game.status),
            'host', jsonb_build_object(
                'id', v_host_profile.id, 'username', v_host_profile.username,
                'display_name', COALESCE(v_host_profile.display_name,
                                         v_host_profile.username),
                'avatar_url', v_host_profile.avatar_url),
            'conversation_id', v_conv_id,
            'dm_url', CASE WHEN v_conv_id IS NOT NULL
                           THEN '/hub/messenger/' || v_conv_id::text
                           ELSE NULL END);
    END IF;

    IF NOT v_game.allow_guests AND p_bringing_guests > 0 THEN
        RAISE EXCEPTION 'GUESTS_NOT_ALLOWED';
    END IF;
    IF v_game.allow_guests AND v_game.guest_limit IS NOT NULL
       AND p_bringing_guests > v_game.guest_limit THEN
        RAISE EXCEPTION 'GUEST_LIMIT_EXCEEDED'
              USING HINT = 'maximum ' || v_game.guest_limit || ' guests per player';
    END IF;

    INSERT INTO commander_home_rsvps AS r
        (game_id, user_id, response, bringing_guests, message, responded_at, updated_at)
    VALUES
        (p_game_id, p_caller_user_id, p_response, p_bringing_guests, p_message, NOW(), NOW())
    ON CONFLICT (game_id, user_id) DO UPDATE
        SET response=EXCLUDED.response, bringing_guests=EXCLUDED.bringing_guests,
            message=EXCLUDED.message, updated_at=NOW()
    RETURNING id INTO v_rsvp_id;

    SELECT id, rsvp_yes, rsvp_maybe, rsvp_no, waitlist_count INTO v_updated_game
      FROM commander_home_games WHERE id = p_game_id;

    RETURN jsonb_build_object(
        'success', true, 'rsvp_id', v_rsvp_id, 'game_id', p_game_id, 'response', p_response,
        'counts', jsonb_build_object('yes', v_updated_game.rsvp_yes,
            'maybe', v_updated_game.rsvp_maybe, 'no', v_updated_game.rsvp_no,
            'waitlist', v_updated_game.waitlist_count));
END;
$function$;

REVOKE ALL ON FUNCTION public.rsvp_to_home_game(uuid,text,uuid,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rsvp_to_home_game(uuid,text,uuid,integer,text) TO authenticated, service_role;

DO $postimage$
DECLARE v_md5 text; v_acl text;
BEGIN
  v_md5 := md5(pg_get_functiondef('public.rsvp_to_home_game(uuid,text,uuid,integer,text)'::regprocedure));
  IF v_md5 IS DISTINCT FROM '50f4569d647404253e60a71b4a8b31cc' THEN
    RAISE EXCEPTION 'RSVP_DIRECT_MESSAGE_POSTIMAGE_CHANGED: %', v_md5;
  END IF;
  SELECT p.proacl::text INTO v_acl FROM pg_proc p
   WHERE p.oid='public.rsvp_to_home_game(uuid,text,uuid,integer,text)'::regprocedure;
  IF v_acl IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'RSVP_DIRECT_MESSAGE_ACL_CHANGED: %', v_acl;
  END IF;
END
$postimage$;

COMMIT;
