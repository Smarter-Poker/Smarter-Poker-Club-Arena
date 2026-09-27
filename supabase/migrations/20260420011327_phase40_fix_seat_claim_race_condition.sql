-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420011327 "phase40_fix_seat_claim_race_condition"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0927c94fe6b50aa40a3f29bf073d5cf5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 34: claim_home_game_seat has a TOCTOU race.
--
-- Current pattern:
--   SELECT FROM seats WHERE game=.. AND seat=..;      -- T1 reads "empty"
--                                                      -- T2 reads "empty"
--   IF status IN ('occupied','away') RAISE 'SEAT_TAKEN';
--   UPDATE seats SET user_id=.. WHERE id=existing.id;  -- T1 wins; T2 overwrites
--
-- Both transactions succeed; T1 sees success response but T2 ends up owning
-- the seat. Two users think they got the same seat.
--
-- assign_home_game_seat has the same shape.
--
-- Fix: atomic conditional UPDATE with `WHERE status='empty'` + check FOUND.
-- If not found, either no seat row exists (try INSERT, unique index catches
-- concurrent INSERT) or the seat is actually taken (raise SEAT_TAKEN).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.claim_home_game_seat(
  p_game_id uuid, p_seat_number integer, p_caller_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_game RECORD;
    v_rsvp RECORD;
    v_player_name text;
    v_updated boolean := false;
    v_seat_row_exists boolean;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
      RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;
    IF p_seat_number < 1 OR p_seat_number > 20 THEN
      RAISE EXCEPTION 'INVALID_SEAT_NUMBER';
    END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    IF v_game.status NOT IN ('scheduled','confirmed','in_progress') THEN
      RAISE EXCEPTION 'GAME_NOT_ACTIVE';
    END IF;
    IF p_seat_number > COALESCE(v_game.max_players, 9) THEN
      RAISE EXCEPTION 'SEAT_EXCEEDS_MAX_PLAYERS';
    END IF;

    SELECT * INTO v_rsvp FROM commander_home_rsvps
     WHERE game_id = p_game_id AND user_id = p_caller_user_id;
    IF NOT FOUND OR v_rsvp.response <> 'yes' THEN
        RAISE EXCEPTION 'NO_YES_RSVP' USING HINT = 'must RSVP yes before claiming a seat';
    END IF;

    -- NOTE: unique index commander_home_seats_one_per_user (game_id, user_id)
    -- WHERE user_id IS NOT NULL enforces ALREADY_SEATED at the DB level.
    -- We still raise a clean error for better UX, but the constraint is the
    -- race-proof backstop.
    IF EXISTS (SELECT 1 FROM commander_home_seats
                WHERE game_id = p_game_id AND user_id = p_caller_user_id
                  AND status IN ('occupied','away')) THEN
        RAISE EXCEPTION 'ALREADY_SEATED';
    END IF;

    SELECT COALESCE(display_name, full_name, username, 'Player') INTO v_player_name
      FROM profiles WHERE id = p_caller_user_id;

    -- Race-safe: atomic conditional UPDATE. Only succeeds if the row exists
    -- AND status='empty'. Two concurrent callers: only one sees status='empty'.
    UPDATE commander_home_seats
       SET user_id    = p_caller_user_id,
           player_name = v_player_name,
           status     = 'occupied',
           seated_at  = NOW(),
           away_since = NULL,
           updated_at = NOW()
     WHERE game_id = p_game_id
       AND seat_number = p_seat_number
       AND status = 'empty';
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF NOT v_updated THEN
      -- Either seat doesn't exist, or it exists but isn't empty
      SELECT EXISTS (SELECT 1 FROM commander_home_seats
                      WHERE game_id = p_game_id AND seat_number = p_seat_number)
        INTO v_seat_row_exists;

      IF v_seat_row_exists THEN
        -- Row exists and is not empty → taken
        RAISE EXCEPTION 'SEAT_TAKEN'
              USING HINT = 'seat ' || p_seat_number || ' is occupied';
      ELSE
        -- No row yet. INSERT. Unique index on (game_id, seat_number) catches
        -- a concurrent INSERT from another caller.
        BEGIN
          INSERT INTO commander_home_seats
            (game_id, seat_number, user_id, player_name, status, seated_at)
          VALUES
            (p_game_id, p_seat_number, p_caller_user_id, v_player_name,
             'occupied', NOW());
        EXCEPTION WHEN unique_violation THEN
          RAISE EXCEPTION 'SEAT_TAKEN'
                USING HINT = 'seat ' || p_seat_number || ' was claimed concurrently';
        END;
      END IF;
    END IF;

    UPDATE commander_home_rsvps
       SET checked_in_at = COALESCE(checked_in_at, NOW()),
           flaked = false, updated_at = NOW()
     WHERE id = v_rsvp.id;

    RETURN jsonb_build_object('success', true, 'seat_number', p_seat_number);
END;
$function$;

COMMENT ON FUNCTION public.claim_home_game_seat IS
  'Phase 40: race-safe. Uses atomic conditional UPDATE (WHERE status=empty) '
  'plus unique-index backstop on (game_id, seat_number). Two concurrent '
  'callers can no longer silently overwrite each other.';

-- Same fix for assign_home_game_seat (admin action)
CREATE OR REPLACE FUNCTION public.assign_home_game_seat(
  p_game_id uuid, p_seat_number integer, p_user_id uuid,
  p_player_name text DEFAULT NULL::text,
  p_caller_user_id uuid DEFAULT NULL::uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_game RECORD;
    v_group RECORD;
    v_resolved_name text;
    v_new_status text;
    v_new_seated_at timestamptz;
    v_updated boolean;
    v_seat_row_exists boolean;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
      RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;
    IF p_seat_number < 1 OR p_seat_number > 20 THEN
      RAISE EXCEPTION 'INVALID_SEAT_NUMBER';
    END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    IF v_game.status NOT IN ('scheduled','confirmed','in_progress') THEN
      RAISE EXCEPTION 'GAME_NOT_ACTIVE';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    IF v_game.host_id <> p_caller_user_id
       AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members
                        WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                          AND role = 'admin' AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;

    IF p_seat_number > COALESCE(v_game.max_players, 9) THEN
      RAISE EXCEPTION 'SEAT_EXCEEDS_MAX_PLAYERS';
    END IF;

    v_resolved_name := COALESCE(p_player_name,
      (SELECT COALESCE(display_name, full_name, username) FROM profiles WHERE id = p_user_id));
    v_new_status := CASE WHEN p_user_id IS NULL THEN 'empty' ELSE 'occupied' END;
    v_new_seated_at := CASE WHEN p_user_id IS NULL THEN NULL ELSE NOW() END;

    -- Atomic UPSERT. When a row exists, the UPDATE wins vs concurrent writers.
    -- The staff user explicitly chose to assign/replace, so we don't guard on
    -- status='empty' — staff CAN override. The unique constraint on
    -- (game_id, user_id) still prevents the assigned user from holding two
    -- seats simultaneously.
    INSERT INTO commander_home_seats
      (game_id, seat_number, user_id, player_name, status, seated_at)
    VALUES
      (p_game_id, p_seat_number, p_user_id, v_resolved_name, v_new_status, v_new_seated_at)
    ON CONFLICT (game_id, seat_number) DO UPDATE
      SET user_id     = EXCLUDED.user_id,
          player_name = EXCLUDED.player_name,
          status      = EXCLUDED.status,
          seated_at   = EXCLUDED.seated_at,
          away_since  = NULL,
          updated_at  = NOW();

    RETURN jsonb_build_object('success', true, 'seat_number', p_seat_number, 'user_id', p_user_id);
END;
$function$;

COMMENT ON FUNCTION public.assign_home_game_seat IS
  'Phase 40: race-safe via INSERT ... ON CONFLICT DO UPDATE. Staff can '
  'override any seat state intentionally. (game_id, user_id) unique index '
  'prevents a user from being double-seated.';
