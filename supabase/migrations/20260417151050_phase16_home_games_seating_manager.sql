-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417151050 "phase16_home_games_seating_manager"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b97a0e4c96d28e21d4ba6fb11cb1daf6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════
--  PHASE 16: HOME-GAMES SEATING MANAGER
-- ══════════════════════════════════════════════════════════════════════
--
--  Host tool to lay out who sits where at a physical home game. Fits
--  into the "all-in-one home game" initiative: pre-game, the host plans
--  seats from their confirmed RSVP list; during the game, they track
--  away status, guest substitutes, and re-seats.
--
--  WHY A NEW TABLE, NOT commander_seats
--
--  The existing commander_seats table has:
--    • FK: game_id → commander_games(id) ON DELETE CASCADE
--      commander_games is Club Arena's online-sessions table, not
--      commander_home_games. Inserting a home-game id would violate
--      the FK. Removing/altering the FK would break online-seating.
--    • buyin_amount integer
--      Money tracking. Per the Phase 14 revert directive, the platform
--      does not record, compute, track, mediate, or facilitate any
--      financial transactions for home games.
--
--  A parallel commander_home_seats table cleanly matches the existing
--  commander_home_* family (groups, games, rsvps, members, posts).
--
--  TABLE
--
--    commander_home_seats
--      id           uuid PK
--      game_id      uuid NOT NULL  → commander_home_games(id) CASCADE
--      seat_number  integer NOT NULL CHECK 1..12
--      user_id      uuid            → auth.users(id) SET NULL
--                                     NULL for unassigned/guest seats
--      player_name  text            manual name for guest/non-platform
--      status       text NOT NULL DEFAULT 'empty'
--                   CHECK IN (empty, reserved, seated, away)
--      seated_at    timestamptz     when player took the seat
--      away_since   timestamptz     temporary absence (bathroom/food)
--      note         text            host note
--      updated_at   timestamptz
--      created_at   timestamptz
--
--      UNIQUE (game_id, seat_number)
--      UNIQUE (game_id, user_id) WHERE user_id IS NOT NULL
--
--  RPCs (all SECURITY DEFINER, staff authz enforced in-body)
--
--    fn_home_caller_is_game_staff     recreated (was dropped with
--                                      Phase 14 revert); reusable.
--    fn_home_init_seats                idempotent — ensures rows 1..N
--                                      exist for a game, preserves any
--                                      existing assignments.
--    fn_home_assign_seat               assign a user (platform-member)
--                                      OR a guest name to a seat.
--                                      Vacates any previous seat that
--                                      same user had in this game.
--    fn_home_vacate_seat               mark empty; clear user/name.
--    fn_home_move_seat                 atomic swap of two seats
--                                      (user/name/status preserved).
--    fn_home_set_seat_status           set seated / away / reserved.
--                                      Updates seated_at/away_since
--                                      timestamps accordingly.
--    fn_home_randomize_seats           shuffle all RSVP'd yes-confirmed
--                                      players into empty seats. Does
--                                      NOT disturb existing assignments
--                                      — host can clear first if they
--                                      want a full re-shuffle.
--    fn_home_list_seats                read-only view of a game's chart,
--                                      joined with profiles for names.
-- ══════════════════════════════════════════════════════════════════════

-- ── commander_home_seats ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commander_home_seats (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id      uuid NOT NULL REFERENCES commander_home_games(id) ON DELETE CASCADE,
    seat_number  integer NOT NULL CHECK (seat_number >= 1 AND seat_number <= 12),
    user_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    player_name  text,
    status       text NOT NULL DEFAULT 'empty'
                   CHECK (status IN ('empty','reserved','seated','away')),
    seated_at    timestamptz,
    away_since   timestamptz,
    note         text,
    updated_at   timestamptz NOT NULL DEFAULT NOW(),
    created_at   timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE (game_id, seat_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS commander_home_seats_one_per_user
    ON commander_home_seats (game_id, user_id) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commander_home_seats_user
    ON commander_home_seats (user_id) WHERE user_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════
--  RPCs
-- ══════════════════════════════════════════════════════════════════════

-- Recreate authz helper (was dropped with Phase 14 revert)
CREATE OR REPLACE FUNCTION fn_home_caller_is_game_staff(p_caller uuid, p_game_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_group_id uuid;
BEGIN
    IF p_caller IS NULL OR p_game_id IS NULL THEN RETURN false; END IF;

    SELECT g.group_id INTO v_group_id FROM commander_home_games g WHERE g.id = p_game_id;
    IF v_group_id IS NULL THEN RETURN false; END IF;

    IF EXISTS (SELECT 1 FROM commander_home_groups
               WHERE id = v_group_id AND owner_id = p_caller) THEN
        RETURN true;
    END IF;

    IF EXISTS (SELECT 1 FROM commander_home_members
               WHERE group_id = v_group_id
                 AND user_id = p_caller
                 AND status = 'approved'
                 AND role IN ('owner','admin')) THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$$;

-- ── fn_home_init_seats ──────────────────────────────────────────────
-- Idempotent. Ensures rows 1..N exist. Preserves existing assignments.
-- If p_max_players omitted, reads from commander_home_games.max_players.
CREATE OR REPLACE FUNCTION fn_home_init_seats(
    p_caller       uuid,
    p_game_id      uuid,
    p_max_players  integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_max         integer;
    v_created     integer := 0;
BEGIN
    IF NOT fn_home_caller_is_game_staff(p_caller, p_game_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not authorized');
    END IF;

    -- Resolve max_players from the game if not supplied
    IF p_max_players IS NULL THEN
        SELECT max_players INTO v_max
          FROM commander_home_games WHERE id = p_game_id;
    ELSE
        v_max := p_max_players;
    END IF;

    IF v_max IS NULL OR v_max < 1 OR v_max > 12 THEN
        RETURN jsonb_build_object('success', false, 'error', 'max_players must be 1..12');
    END IF;

    -- Insert missing seats 1..v_max. Rows that already exist are left alone.
    WITH want AS (
        SELECT generate_series(1, v_max) AS n
    ),
    ins AS (
        INSERT INTO commander_home_seats (game_id, seat_number)
        SELECT p_game_id, w.n FROM want w
        ON CONFLICT (game_id, seat_number) DO NOTHING
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_created FROM ins;

    RETURN jsonb_build_object(
        'success', true,
        'game_id', p_game_id,
        'max_players', v_max,
        'seats_created', v_created
    );
END;
$$;

-- ── fn_home_assign_seat ─────────────────────────────────────────────
-- Assign a user or guest name to a seat. Auto-vacates any other seat
-- that user currently occupies in the same game (enforces one-seat-
-- per-user via the UNIQUE index; this keeps the operation atomic).
-- Sets status='seated' and seated_at=NOW() if not already seated.
CREATE OR REPLACE FUNCTION fn_home_assign_seat(
    p_caller       uuid,
    p_game_id      uuid,
    p_seat_number  integer,
    p_user_id      uuid    DEFAULT NULL,
    p_player_name  text    DEFAULT NULL,
    p_note         text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_exists boolean;
BEGIN
    IF NOT fn_home_caller_is_game_staff(p_caller, p_game_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not authorized');
    END IF;
    IF p_seat_number IS NULL OR p_seat_number < 1 OR p_seat_number > 12 THEN
        RETURN jsonb_build_object('success', false, 'error', 'seat_number must be 1..12');
    END IF;
    IF p_user_id IS NULL AND (p_player_name IS NULL OR LENGTH(TRIM(p_player_name)) = 0) THEN
        RETURN jsonb_build_object('success', false, 'error', 'either user_id or player_name required');
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM commander_home_seats
         WHERE game_id = p_game_id AND seat_number = p_seat_number
    ) INTO v_exists;
    IF NOT v_exists THEN
        -- Create the row on-the-fly if seats weren't init'd
        INSERT INTO commander_home_seats (game_id, seat_number)
        VALUES (p_game_id, p_seat_number);
    END IF;

    -- If this user already sits elsewhere in this game, vacate that seat.
    IF p_user_id IS NOT NULL THEN
        UPDATE commander_home_seats
           SET user_id = NULL, player_name = NULL, status = 'empty',
               seated_at = NULL, away_since = NULL, note = NULL,
               updated_at = NOW()
         WHERE game_id = p_game_id
           AND user_id = p_user_id
           AND seat_number <> p_seat_number;
    END IF;

    UPDATE commander_home_seats
       SET user_id = p_user_id,
           player_name = p_player_name,
           status = 'seated',
           seated_at = COALESCE(seated_at, NOW()),
           away_since = NULL,
           note = p_note,
           updated_at = NOW()
     WHERE game_id = p_game_id AND seat_number = p_seat_number;

    RETURN jsonb_build_object('success', true,
        'game_id', p_game_id, 'seat_number', p_seat_number);
END;
$$;

-- ── fn_home_vacate_seat ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_home_vacate_seat(
    p_caller       uuid,
    p_game_id      uuid,
    p_seat_number  integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    IF NOT fn_home_caller_is_game_staff(p_caller, p_game_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not authorized');
    END IF;

    UPDATE commander_home_seats
       SET user_id = NULL, player_name = NULL, status = 'empty',
           seated_at = NULL, away_since = NULL, note = NULL,
           updated_at = NOW()
     WHERE game_id = p_game_id AND seat_number = p_seat_number;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'seat not found');
    END IF;
    RETURN jsonb_build_object('success', true,
        'game_id', p_game_id, 'seat_number', p_seat_number);
END;
$$;

-- ── fn_home_move_seat ───────────────────────────────────────────────
-- Atomic swap of two seats. If destination is occupied, swaps their
-- occupants; if destination is empty, moves the from-player to it.
CREATE OR REPLACE FUNCTION fn_home_move_seat(
    p_caller        uuid,
    p_game_id       uuid,
    p_from_seat     integer,
    p_to_seat       integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    r_from commander_home_seats%ROWTYPE;
    r_to   commander_home_seats%ROWTYPE;
BEGIN
    IF NOT fn_home_caller_is_game_staff(p_caller, p_game_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not authorized');
    END IF;
    IF p_from_seat = p_to_seat THEN
        RETURN jsonb_build_object('success', true, 'noop', true);
    END IF;

    SELECT * INTO r_from FROM commander_home_seats
     WHERE game_id = p_game_id AND seat_number = p_from_seat FOR UPDATE;
    SELECT * INTO r_to   FROM commander_home_seats
     WHERE game_id = p_game_id AND seat_number = p_to_seat   FOR UPDATE;

    IF r_from.id IS NULL OR r_to.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'seat(s) not found');
    END IF;

    -- Work around the one-seat-per-user UNIQUE index by parking the
    -- from-seat's user temporarily (NULL), then setting the destination,
    -- then setting the from-seat to the ex-destination's user.
    UPDATE commander_home_seats SET user_id = NULL, updated_at = NOW()
      WHERE id = r_from.id;

    UPDATE commander_home_seats
       SET user_id = r_from.user_id,
           player_name = r_from.player_name,
           status = r_from.status,
           seated_at = r_from.seated_at,
           away_since = r_from.away_since,
           note = r_from.note,
           updated_at = NOW()
     WHERE id = r_to.id;

    UPDATE commander_home_seats
       SET user_id = r_to.user_id,
           player_name = r_to.player_name,
           status = r_to.status,
           seated_at = r_to.seated_at,
           away_since = r_to.away_since,
           note = r_to.note,
           updated_at = NOW()
     WHERE id = r_from.id;

    RETURN jsonb_build_object('success', true,
        'game_id', p_game_id, 'from', p_from_seat, 'to', p_to_seat);
END;
$$;

-- ── fn_home_set_seat_status ────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_home_set_seat_status(
    p_caller       uuid,
    p_game_id      uuid,
    p_seat_number  integer,
    p_status       text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    IF NOT fn_home_caller_is_game_staff(p_caller, p_game_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not authorized');
    END IF;
    IF p_status NOT IN ('empty','reserved','seated','away') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid status');
    END IF;

    UPDATE commander_home_seats
       SET status = p_status,
           seated_at = CASE WHEN p_status='seated' THEN COALESCE(seated_at, NOW()) ELSE seated_at END,
           away_since = CASE WHEN p_status='away'  THEN NOW() ELSE NULL END,
           updated_at = NOW()
     WHERE game_id = p_game_id AND seat_number = p_seat_number;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'seat not found');
    END IF;
    RETURN jsonb_build_object('success', true);
END;
$$;

-- ── fn_home_randomize_seats ────────────────────────────────────────
-- Shuffle confirmed-yes RSVP'd users into empty seats.
-- Doesn't touch seats that are already assigned.
CREATE OR REPLACE FUNCTION fn_home_randomize_seats(
    p_caller   uuid,
    p_game_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_assigned integer := 0;
BEGIN
    IF NOT fn_home_caller_is_game_staff(p_caller, p_game_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not authorized');
    END IF;

    -- Users to seat: confirmed-yes RSVPs not already seated somewhere
    WITH candidates AS (
        SELECT r.user_id
          FROM commander_home_rsvps r
         WHERE r.game_id = p_game_id
           AND r.is_confirmed = true
           AND r.response = 'yes'
           AND NOT EXISTS (
               SELECT 1 FROM commander_home_seats s
                WHERE s.game_id = p_game_id AND s.user_id = r.user_id
           )
         ORDER BY random()
    ),
    empties AS (
        SELECT seat_number
          FROM commander_home_seats
         WHERE game_id = p_game_id
           AND user_id IS NULL
           AND status = 'empty'
         ORDER BY seat_number
    ),
    pairs AS (
        -- Zip candidates to empties by row_number
        SELECT c.user_id, e.seat_number FROM (
            SELECT user_id, ROW_NUMBER() OVER () AS rn FROM candidates
        ) c
        JOIN (
            SELECT seat_number, ROW_NUMBER() OVER () AS rn FROM empties
        ) e ON c.rn = e.rn
    ),
    upd AS (
        UPDATE commander_home_seats s
           SET user_id = p.user_id,
               status = 'seated',
               seated_at = NOW(),
               updated_at = NOW()
          FROM pairs p
         WHERE s.game_id = p_game_id
           AND s.seat_number = p.seat_number
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_assigned FROM upd;

    RETURN jsonb_build_object('success', true, 'game_id', p_game_id, 'assigned', v_assigned);
END;
$$;

-- ── fn_home_list_seats ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_home_list_seats(p_game_id uuid)
RETURNS TABLE (
    seat_number   integer,
    status        text,
    user_id       uuid,
    username      text,
    display_name  text,
    avatar_url    text,
    player_name   text,
    seated_at     timestamptz,
    away_since    timestamptz,
    note          text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.seat_number,
        s.status,
        s.user_id,
        p.username,
        COALESCE(p.display_name, p.full_name, p.username) AS display_name,
        p.avatar_url,
        s.player_name,
        s.seated_at,
        s.away_since,
        s.note
    FROM commander_home_seats s
    LEFT JOIN profiles p ON p.id = s.user_id
    WHERE s.game_id = p_game_id
    ORDER BY s.seat_number;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_home_caller_is_game_staff(uuid, uuid)                           TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_home_init_seats(uuid, uuid, integer)                             TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_home_assign_seat(uuid, uuid, integer, uuid, text, text)          TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_home_vacate_seat(uuid, uuid, integer)                            TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_home_move_seat(uuid, uuid, integer, integer)                    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_home_set_seat_status(uuid, uuid, integer, text)                 TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_home_randomize_seats(uuid, uuid)                                 TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_home_list_seats(uuid)                                            TO authenticated, service_role;
