-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260421040439 "20260421041500_phase_b_pass8_live_game_state_seat_status_enum"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e7d2678cbfe8115264076d7ff816145a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase B Pass 8 — BUG-7 (CRITICAL, customer-breaking)
--
-- get_live_home_game_state is the host-side live-roster dashboard RPC
-- for Home Games (commander_home_*). It was filtering seats on
--     status = 'occupied'
-- but EVERY writer (claim_home_game_seat, fn_home_assign_seat,
-- fn_home_randomize_seats, fn_home_set_seat_status, rpc_hg_change_seat)
-- stores
--     status = 'seated'
-- for an occupied seat. 'occupied' is the Club Arena enum, used by
-- the parallel commander_seats table. Home Games uses a different
-- enum: {empty, seated, away, reserved}.
--
-- Impact:
--   - The host's "Seated players" section shows ZERO players, always,
--     regardless of how many seats are actually claimed.
--   - The en_route calculation has
--         NOT EXISTS (... WHERE s.status IN ('occupied','away'))
--     — the 'occupied' branch never matches, so seated (non-away)
--     players are incorrectly surfaced as "en route" — they appear in
--     the dashboard as "haven't arrived yet" even after they've sat
--     down.
--
-- Why this hasn't been caught yet: the commander_home_seats table
-- currently has 0 rows in prod (no one has run a live home game with
-- seat claims yet). The moment a host starts using the live roster
-- feature, the dashboard will silently misreport the table state.
--
-- Fix: replace both 'occupied' references with 'seated'. Behavior is
-- otherwise preserved verbatim.
--
-- Note the sibling bug is NOT present in update_game_player_count —
-- that function operates on commander_seats (Club Arena), not
-- commander_home_seats (Home Games), and 'occupied' is correct there.

CREATE OR REPLACE FUNCTION public.get_live_home_game_state(
    p_game_id uuid,
    p_caller_user_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_game  RECORD;
    v_group RECORD;
    v_is_host boolean;
    v_seated jsonb;
    v_away   jsonb;
    v_enroute jsonb;
    v_waitlist jsonb;
    v_no_response jsonb;
    v_flakes jsonb;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    v_is_host := (v_game.host_id = p_caller_user_id)
              OR (v_group.owner_id = p_caller_user_id)
              OR EXISTS (SELECT 1 FROM commander_home_members
                          WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                            AND role = 'admin' AND status = 'approved');
    IF NOT v_is_host THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    -- BUG-7 fix: 'seated' is the Home Games enum for an occupied seat.
    -- 'occupied' is the Club Arena enum (commander_seats, different table).
    SELECT jsonb_agg(jsonb_build_object(
        'seat_number', s.seat_number, 'user_id', s.user_id,
        'player_name', COALESCE(s.player_name, p.display_name, p.full_name, 'Player'),
        'avatar_url', p.avatar_url,
        'seated_at', s.seated_at,
        'checked_in_at', r.checked_in_at
    ) ORDER BY s.seat_number)
    INTO v_seated
    FROM commander_home_seats s
    LEFT JOIN profiles p ON p.id = s.user_id
    LEFT JOIN commander_home_rsvps r ON r.game_id = s.game_id AND r.user_id = s.user_id
    WHERE s.game_id = p_game_id AND s.status = 'seated';

    SELECT jsonb_agg(jsonb_build_object(
        'seat_number', s.seat_number, 'user_id', s.user_id,
        'player_name', COALESCE(s.player_name, p.display_name, p.full_name, 'Player'),
        'avatar_url', p.avatar_url,
        'away_since', s.away_since
    ) ORDER BY s.seat_number)
    INTO v_away
    FROM commander_home_seats s
    LEFT JOIN profiles p ON p.id = s.user_id
    WHERE s.game_id = p_game_id AND s.status = 'away';

    -- BUG-7 fix (second site): en_route exclusion must match the seated/away
    -- enum. Previously 'occupied' here never matched, so seated-and-in-person
    -- players were misreported as en_route (haven't arrived yet).
    SELECT jsonb_agg(jsonb_build_object(
        'user_id', r.user_id,
        'player_name', COALESCE(p.display_name, p.full_name, 'Player'),
        'avatar_url', p.avatar_url,
        'bringing_guests', r.bringing_guests
    ))
    INTO v_enroute
    FROM commander_home_rsvps r
    LEFT JOIN profiles p ON p.id = r.user_id
    WHERE r.game_id = p_game_id
      AND r.response = 'yes'
      AND r.checked_in_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM commander_home_seats s
                       WHERE s.game_id = p_game_id AND s.user_id = r.user_id
                         AND s.status IN ('seated','away'));

    SELECT jsonb_agg(jsonb_build_object(
        'user_id', r.user_id,
        'player_name', COALESCE(p.display_name, p.full_name, 'Player'),
        'avatar_url', p.avatar_url,
        'joined_waitlist_at', r.responded_at
    ) ORDER BY r.responded_at)
    INTO v_waitlist
    FROM commander_home_rsvps r
    LEFT JOIN profiles p ON p.id = r.user_id
    WHERE r.game_id = p_game_id AND r.response = 'waitlist';

    SELECT jsonb_agg(jsonb_build_object(
        'user_id', m.user_id,
        'player_name', COALESCE(p.display_name, p.full_name, 'Member'),
        'avatar_url', p.avatar_url
    ))
    INTO v_no_response
    FROM commander_home_members m
    LEFT JOIN profiles p ON p.id = m.user_id
    WHERE m.group_id = v_game.group_id
      AND m.status = 'approved'
      AND NOT EXISTS (SELECT 1 FROM commander_home_rsvps r
                       WHERE r.game_id = p_game_id AND r.user_id = m.user_id);

    SELECT jsonb_agg(jsonb_build_object(
        'user_id', r.user_id,
        'player_name', COALESCE(p.display_name, p.full_name, 'Player'),
        'avatar_url', p.avatar_url
    ))
    INTO v_flakes
    FROM commander_home_rsvps r
    LEFT JOIN profiles p ON p.id = r.user_id
    WHERE r.game_id = p_game_id AND r.flaked = true;

    RETURN jsonb_build_object(
        'success', true,
        'game', jsonb_build_object(
            'id', v_game.id, 'title', v_game.title,
            'status', v_game.status,
            'scheduled_date', v_game.scheduled_date,
            'start_time', v_game.start_time,
            'max_players', COALESCE(v_game.max_players, 9),
            'rsvp_yes', v_game.rsvp_yes, 'rsvp_maybe', v_game.rsvp_maybe,
            'rsvp_no', v_game.rsvp_no, 'waitlist_count', v_game.waitlist_count
        ),
        'seated', COALESCE(v_seated, '[]'::jsonb),
        'seated_count', jsonb_array_length(COALESCE(v_seated, '[]'::jsonb)),
        'away', COALESCE(v_away, '[]'::jsonb),
        'en_route', COALESCE(v_enroute, '[]'::jsonb),
        'en_route_count', jsonb_array_length(COALESCE(v_enroute, '[]'::jsonb)),
        'waitlist', COALESCE(v_waitlist, '[]'::jsonb),
        'no_response', COALESCE(v_no_response, '[]'::jsonb),
        'flakes', COALESCE(v_flakes, '[]'::jsonb)
    );
END;
$function$;
