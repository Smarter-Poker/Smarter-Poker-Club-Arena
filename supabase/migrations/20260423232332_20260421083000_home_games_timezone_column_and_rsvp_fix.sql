-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423232332 "20260421083000_home_games_timezone_column_and_rsvp_fix"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0c422d7c7e35bd591118b3268c590498 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- PHASE 4 (F154): Timezone fix for game-started detection
--
-- Before: rsvp_to_home_game computed v_game_start_ts as
--   v_game.scheduled_date + v_game.start_time
-- which yields a naive `timestamp` in the DB session's timezone (UTC in
-- production). Comparing that against NOW() (which is timestamptz) caused
-- an implicit cast — the naive timestamp is assumed to be UTC, so hosts
-- in non-UTC zones see "game started" fire off by several hours.
--
-- Example of the bug: host in America/Chicago schedules a 7:00 PM game
-- on 2026-05-10. DB stores start_time='19:00:00' and scheduled_date=
-- '2026-05-10'. The RPC computes 2026-05-10 19:00:00 (UTC). At 2 PM
-- Chicago time (19:00 UTC), the game "starts" per the RPC — five hours
-- before the host actually sits down. All RSVPs get redirected to
-- "message the host" from that point.
--
-- Fix:
--   1) Add `timezone text` column to commander_home_groups. Default to
--      'America/New_York' as a reasonable US-centric default; the UI
--      should let hosts pick.
--   2) Optional override per-game: `timezone` column on commander_home_games
--      so a single game can override (e.g. a traveling group).
--   3) Update rsvp_to_home_game to compute v_game_start_ts as
--      (scheduled_date + start_time) AT TIME ZONE <tz>
--      which correctly produces a timestamptz representing the host's
--      wall-clock time.

BEGIN;

ALTER TABLE public.commander_home_groups
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/New_York';

-- Basic validation: reject invalid timezone names at write time
-- by ensuring the string resolves via the pg_timezone_names catalog.
-- We use a trigger (CHECK can't reference a catalog) but keep it very
-- lightweight.
CREATE OR REPLACE FUNCTION public.fn_validate_home_group_timezone()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.timezone IS NULL OR NEW.timezone = '' THEN
    NEW.timezone := 'America/New_York';
  ELSIF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'INVALID_TIMEZONE'
      USING HINT = 'timezone "' || NEW.timezone || '" is not a recognized IANA timezone name';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_validate_home_group_timezone
  ON public.commander_home_groups;
CREATE TRIGGER trg_validate_home_group_timezone
  BEFORE INSERT OR UPDATE OF timezone ON public.commander_home_groups
  FOR EACH ROW EXECUTE FUNCTION public.fn_validate_home_group_timezone();

-- Per-game override
ALTER TABLE public.commander_home_games
  ADD COLUMN IF NOT EXISTS timezone text;

-- Reuse the same validator (NULL is allowed — falls through to group)
CREATE OR REPLACE FUNCTION public.fn_validate_home_game_timezone()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.timezone IS NOT NULL AND NEW.timezone <> '' THEN
    IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
      RAISE EXCEPTION 'INVALID_TIMEZONE'
        USING HINT = 'timezone "' || NEW.timezone || '" is not a recognized IANA timezone name';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_validate_home_game_timezone
  ON public.commander_home_games;
CREATE TRIGGER trg_validate_home_game_timezone
  BEFORE INSERT OR UPDATE OF timezone ON public.commander_home_games
  FOR EACH ROW EXECUTE FUNCTION public.fn_validate_home_game_timezone();

-- Patch rsvp_to_home_game to use timezone-aware comparison ------------
CREATE OR REPLACE FUNCTION public.rsvp_to_home_game(
  p_game_id         uuid,
  p_response        text,
  p_caller_user_id  uuid,
  p_bringing_guests integer DEFAULT 0,
  p_message         text    DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_game         RECORD;
    v_group        RECORD;
    v_host_profile RECORD;
    v_is_member    boolean := false;
    v_is_banned    boolean := false;
    v_rsvp_id      uuid;
    v_updated_game RECORD;
    v_game_start_ts timestamptz;     -- now tz-aware (was naive)
    v_effective_tz  text;
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

    IF v_game.status = 'cancelled' THEN
        RAISE EXCEPTION 'GAME_NOT_OPEN_FOR_RSVP'
              USING HINT = 'game status is cancelled';
    END IF;

    IF v_game.status NOT IN ('scheduled','confirmed','in_progress','completed') THEN
        RAISE EXCEPTION 'GAME_NOT_OPEN_FOR_RSVP'
              USING HINT = 'game status is ' || COALESCE(v_game.status,'NULL');
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

    SELECT EXISTS (
      SELECT 1 FROM commander_home_members
       WHERE group_id = v_game.group_id
         AND user_id  = p_caller_user_id
         AND status   = 'banned'
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
           AND user_id  = p_caller_user_id
           AND status   = 'approved'
    ) INTO v_is_member;

    IF v_group.is_private AND NOT v_is_member THEN
        RAISE EXCEPTION 'NOT_A_MEMBER'
              USING HINT = 'private group RSVP requires approved membership';
    END IF;

    -- F154 FIX: timezone-aware start-time detection ───────────────────
    -- Effective timezone: per-game override wins, else group timezone,
    -- else hard default 'America/New_York'.
    v_effective_tz := COALESCE(
                        NULLIF(v_game.timezone, ''),
                        NULLIF(v_group.timezone, ''),
                        'America/New_York'
                      );
    -- Compose scheduled_date + start_time as a local wall-clock
    -- timestamp, interpret it in the effective timezone, yielding a
    -- correct timestamptz. Compare against now() which is also tz-aware.
    v_game_start_ts := (v_game.scheduled_date + v_game.start_time)
                       AT TIME ZONE v_effective_tz;

    IF v_game.status = 'completed'
       OR v_game.status = 'in_progress'
       OR v_game_start_ts <= NOW()
    THEN
        IF p_caller_user_id = v_game.host_id THEN
            RAISE EXCEPTION 'HOST_CANNOT_RSVP_TO_OWN_GAME';
        END IF;

        v_dm_result := public.fn_get_or_create_conversation(
            p_caller_user_id, v_game.host_id, 'direct'
        );
        IF COALESCE((v_dm_result->>'success')::boolean, false) THEN
            v_conv_id := (v_dm_result->>'conversation_id')::uuid;
        ELSE
            v_conv_id := NULL;
        END IF;

        SELECT p.id, p.username, p.display_name, p.full_name, p.avatar_url
          INTO v_host_profile
          FROM profiles p
         WHERE p.id = v_game.host_id;

        RETURN jsonb_build_object(
            'success', false,
            'error',   'GAME_STARTED',
            'message', 'This game has already started. Message the host directly.',
            'game', jsonb_build_object(
                'id',             v_game.id,
                'scheduled_date', v_game.scheduled_date,
                'start_time',     v_game.start_time,
                'timezone',       v_effective_tz,
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
            'dm_url', CASE WHEN v_conv_id IS NOT NULL
                           THEN '/hub/messenger/' || v_conv_id::text
                           ELSE NULL
                      END
        );
    END IF;

    -- Normal future-game RSVP path ────────────────────────────────────
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
$function$;

COMMIT;
