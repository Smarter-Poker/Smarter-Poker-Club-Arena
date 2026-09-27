-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420011501 "phase40_fix_seat_status_check_drift"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6df302586da92f02a643784eec43b722 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 35: commander_home_seats status CHECK drift.
--
-- The CHECK constraint allows ('empty','reserved','seated','away') but every
-- RPC writes 'occupied'. Result: every seat-claim attempt fails with CHECK
-- violation. Feature is silently broken — zero rows in production confirm
-- the feature has never worked.
--
-- Fix: normalize all RPCs to use 'seated' (matching the CHECK). No data
-- migration needed since no rows exist.
-- ============================================================================

-- claim_home_game_seat: swap 'occupied' → 'seated' in all paths
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

    IF EXISTS (SELECT 1 FROM commander_home_seats
                WHERE game_id = p_game_id AND user_id = p_caller_user_id
                  AND status IN ('seated','away')) THEN
        RAISE EXCEPTION 'ALREADY_SEATED';
    END IF;

    SELECT COALESCE(display_name, full_name, username, 'Player') INTO v_player_name
      FROM profiles WHERE id = p_caller_user_id;

    UPDATE commander_home_seats
       SET user_id    = p_caller_user_id,
           player_name = v_player_name,
           status     = 'seated',
           seated_at  = NOW(),
           away_since = NULL,
           updated_at = NOW()
     WHERE game_id = p_game_id
       AND seat_number = p_seat_number
       AND status = 'empty';
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF NOT v_updated THEN
      SELECT EXISTS (SELECT 1 FROM commander_home_seats
                      WHERE game_id = p_game_id AND seat_number = p_seat_number)
        INTO v_seat_row_exists;

      IF v_seat_row_exists THEN
        RAISE EXCEPTION 'SEAT_TAKEN'
              USING HINT = 'seat ' || p_seat_number || ' is occupied';
      ELSE
        BEGIN
          INSERT INTO commander_home_seats
            (game_id, seat_number, user_id, player_name, status, seated_at)
          VALUES
            (p_game_id, p_seat_number, p_caller_user_id, v_player_name,
             'seated', NOW());
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

-- assign_home_game_seat: swap 'occupied' → 'seated'
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
    v_new_status := CASE WHEN p_user_id IS NULL THEN 'empty' ELSE 'seated' END;
    v_new_seated_at := CASE WHEN p_user_id IS NULL THEN NULL ELSE NOW() END;

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

-- mark_home_game_seat_away: swap 'occupied' → 'seated'
CREATE OR REPLACE FUNCTION public.mark_home_game_seat_away(
  p_game_id uuid, p_seat_number integer, p_is_away boolean, p_caller_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_game RECORD; v_group RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
      RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;
    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    IF v_game.host_id <> p_caller_user_id AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members
                        WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                          AND role = 'admin' AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;

    UPDATE commander_home_seats
       SET status = CASE WHEN p_is_away THEN 'away' ELSE 'seated' END,
           away_since = CASE WHEN p_is_away THEN NOW() ELSE NULL END,
           updated_at = NOW()
     WHERE game_id = p_game_id AND seat_number = p_seat_number;

    RETURN jsonb_build_object('success', true);
END;
$function$;

COMMENT ON FUNCTION public.claim_home_game_seat IS
  'Phase 40: (a) race-safe via atomic conditional UPDATE + unique-index '
  'backstop; (b) fixed status drift — now writes ''seated'' matching the '
  'CHECK constraint (was ''occupied'', feature was silently broken).';
