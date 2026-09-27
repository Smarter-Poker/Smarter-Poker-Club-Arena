-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419162127 "phase24k_seats_broadcast_analytics_export"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8ab0b4a9cbbdb712992e3e30a9c505f9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 24 PART K — Seats + Broadcast + Analytics + Export
-- =========================================================================

-- ════════════════════════════════════════════════════════════════════════
-- Seat management RPCs
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_home_game_seat_map(
    p_game_id         uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_game     RECORD;
    v_group    RECORD;
    v_seats    jsonb;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    -- Must be host, member, or public group viewer
    IF v_group.is_private 
       AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = v_game.group_id AND user_id = p_caller_user_id 
                          AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;

    SELECT jsonb_agg(jsonb_build_object(
        'seat_number', s.seat_number,
        'user_id', s.user_id,
        'player_name', COALESCE(s.player_name, p.display_name, p.full_name, p.username),
        'avatar_url', p.avatar_url,
        'status', s.status,
        'seated_at', s.seated_at,
        'away_since', s.away_since,
        'note', s.note
    ) ORDER BY s.seat_number)
    INTO v_seats
    FROM commander_home_seats s
    LEFT JOIN profiles p ON p.id = s.user_id
    WHERE s.game_id = p_game_id;

    RETURN jsonb_build_object(
        'success', true,
        'game_id', p_game_id,
        'max_players', COALESCE(v_game.max_players, 9),
        'seats', COALESCE(v_seats, '[]'::jsonb)
    );
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_home_game_seat_map(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_home_game_seat_map(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assign_home_game_seat(
    p_game_id         uuid,
    p_seat_number     int,
    p_user_id         uuid,      -- NULL to unseat
    p_player_name     text DEFAULT NULL,  -- for walk-ins without accounts
    p_caller_user_id  uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_game RECORD; v_group RECORD; v_existing RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_seat_number < 1 OR p_seat_number > 20 THEN RAISE EXCEPTION 'INVALID_SEAT_NUMBER'; END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    IF v_game.status NOT IN ('scheduled','confirmed','in_progress') THEN RAISE EXCEPTION 'GAME_NOT_ACTIVE'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    -- Only host/owner/admin can assign seats
    IF v_game.host_id <> p_caller_user_id 
       AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                          AND role = 'admin' AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;

    IF p_seat_number > COALESCE(v_game.max_players, 9) THEN RAISE EXCEPTION 'SEAT_EXCEEDS_MAX_PLAYERS'; END IF;

    -- Check if seat is already taken
    SELECT * INTO v_existing FROM commander_home_seats 
     WHERE game_id = p_game_id AND seat_number = p_seat_number;

    IF FOUND THEN
        -- Update existing seat
        UPDATE commander_home_seats
           SET user_id = p_user_id,
               player_name = COALESCE(p_player_name, (SELECT COALESCE(display_name, full_name, username) FROM profiles WHERE id = p_user_id)),
               status = CASE WHEN p_user_id IS NULL THEN 'empty' ELSE 'occupied' END,
               seated_at = CASE WHEN p_user_id IS NULL THEN NULL ELSE NOW() END,
               away_since = NULL,
               updated_at = NOW()
         WHERE id = v_existing.id;
    ELSE
        INSERT INTO commander_home_seats (
            game_id, seat_number, user_id, player_name, status, seated_at
        ) VALUES (
            p_game_id, p_seat_number, p_user_id,
            COALESCE(p_player_name, (SELECT COALESCE(display_name, full_name, username) FROM profiles WHERE id = p_user_id)),
            CASE WHEN p_user_id IS NULL THEN 'empty' ELSE 'occupied' END,
            CASE WHEN p_user_id IS NULL THEN NULL ELSE NOW() END
        );
    END IF;

    RETURN jsonb_build_object('success', true, 'seat_number', p_seat_number, 'user_id', p_user_id);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.assign_home_game_seat(uuid, int, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_home_game_seat(uuid, int, uuid, text, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mark_home_game_seat_away(
    p_game_id         uuid,
    p_seat_number     int,
    p_is_away         boolean,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_game RECORD; v_group RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    IF v_game.host_id <> p_caller_user_id AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                          AND role = 'admin' AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;

    UPDATE commander_home_seats
       SET status = CASE WHEN p_is_away THEN 'away' ELSE 'occupied' END,
           away_since = CASE WHEN p_is_away THEN NOW() ELSE NULL END,
           updated_at = NOW()
     WHERE game_id = p_game_id AND seat_number = p_seat_number;

    RETURN jsonb_build_object('success', true);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.mark_home_game_seat_away(uuid, int, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_home_game_seat_away(uuid, int, boolean, uuid) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- Broadcast to RSVPd users — host sends one-shot message to all 'yes'
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.broadcast_to_home_game_rsvps(
    p_game_id         uuid,
    p_message         text,
    p_caller_user_id  uuid,
    p_include_maybe   boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_game RECORD; v_group RECORD; v_slug text;
    v_recipient RECORD; v_sent int := 0;
    v_title text;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_message IS NULL OR length(trim(p_message)) = 0 THEN RAISE EXCEPTION 'EMPTY_MESSAGE'; END IF;
    IF length(p_message) > 1000 THEN RAISE EXCEPTION 'MESSAGE_TOO_LONG'; END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    IF v_game.host_id <> p_caller_user_id AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                          AND role = 'admin' AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;

    SELECT sp.slug INTO v_slug FROM social_pages sp
     WHERE sp.linked_entity_type='home_group' AND sp.linked_entity_id=v_group.id::text LIMIT 1;

    v_title := 'Host message: ' || COALESCE(v_game.title, v_group.name);

    FOR v_recipient IN 
        SELECT DISTINCT user_id FROM commander_home_rsvps 
         WHERE game_id = p_game_id 
           AND response IN ('yes') 
            OR (p_include_maybe AND response = 'maybe')
    LOOP
        PERFORM public.fn_emit_home_notification(
            v_recipient.user_id,
            'home_game_host_broadcast',
            v_title,
            LEFT(p_message, 500),
            '/hub/home-games/' || COALESCE(v_slug, v_group.id::text),
            jsonb_build_object('game_id', p_game_id, 'from_host', p_caller_user_id, 'full_message', p_message),
            NULL  -- always deliver, this is a direct from-host message
        );
        v_sent := v_sent + 1;
    END LOOP;

    INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (v_group.id, p_caller_user_id, 'game', p_game_id, 'host_broadcast',
            jsonb_build_object('recipients', v_sent, 'preview', LEFT(p_message, 100)));

    RETURN jsonb_build_object('success', true, 'recipients_count', v_sent);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.broadcast_to_home_game_rsvps(uuid, text, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broadcast_to_home_game_rsvps(uuid, text, uuid, boolean) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- Host analytics — member engagement stats
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_home_group_member_engagement(
    p_group_id        uuid,
    p_caller_user_id  uuid
) RETURNS TABLE (
    user_id uuid,
    display_name text,
    avatar_url text,
    role text,
    status text,
    is_regular boolean,
    games_attended int,
    games_attended_90d bigint,
    rsvps_yes_90d bigint,
    rsvps_no_90d bigint,
    flake_strikes int,
    last_attended timestamptz,
    last_rsvp_at timestamptz,
    rsvp_flake_rate_pct numeric,
    host_private_note text,
    joined_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_group RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF v_group.owner_id <> p_caller_user_id 
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = p_group_id AND user_id = p_caller_user_id
                          AND role = 'admin' AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    RETURN QUERY
    SELECT 
        m.user_id,
        COALESCE(p.display_name, p.full_name, p.username, 'Member') AS display_name,
        p.avatar_url,
        m.role,
        m.status,
        COALESCE(m.is_regular, false),
        COALESCE(m.games_attended, 0),
        COALESCE((SELECT COUNT(*) FROM commander_home_rsvps r 
                   JOIN commander_home_games g ON g.id=r.game_id
                   WHERE g.group_id = p_group_id AND r.user_id = m.user_id 
                     AND r.checked_in_at IS NOT NULL
                     AND r.checked_in_at > NOW() - INTERVAL '90 days'), 0),
        COALESCE((SELECT COUNT(*) FROM commander_home_rsvps r 
                   JOIN commander_home_games g ON g.id=r.game_id
                   WHERE g.group_id = p_group_id AND r.user_id = m.user_id 
                     AND r.response = 'yes'
                     AND r.responded_at > NOW() - INTERVAL '90 days'), 0),
        COALESCE((SELECT COUNT(*) FROM commander_home_rsvps r 
                   JOIN commander_home_games g ON g.id=r.game_id
                   WHERE g.group_id = p_group_id AND r.user_id = m.user_id 
                     AND r.response = 'no'
                     AND r.responded_at > NOW() - INTERVAL '90 days'), 0),
        COALESCE(m.flake_strikes, 0),
        m.last_attended,
        (SELECT MAX(responded_at) FROM commander_home_rsvps r 
           JOIN commander_home_games g ON g.id=r.game_id
          WHERE g.group_id = p_group_id AND r.user_id = m.user_id),
        -- Flake rate: flakes / yes_rsvps over last 90 days
        CASE 
            WHEN COALESCE((SELECT COUNT(*) FROM commander_home_rsvps r 
                            JOIN commander_home_games g ON g.id=r.game_id
                            WHERE g.group_id = p_group_id AND r.user_id = m.user_id 
                              AND r.response = 'yes'
                              AND r.responded_at > NOW() - INTERVAL '90 days'), 0) = 0 THEN 0
            ELSE ROUND(100.0 * 
                COALESCE((SELECT COUNT(*) FROM commander_home_rsvps r 
                           JOIN commander_home_games g ON g.id=r.game_id
                           WHERE g.group_id = p_group_id AND r.user_id = m.user_id 
                             AND r.flaked = true
                             AND r.responded_at > NOW() - INTERVAL '90 days'), 0)::numeric
                / NULLIF((SELECT COUNT(*) FROM commander_home_rsvps r 
                           JOIN commander_home_games g ON g.id=r.game_id
                           WHERE g.group_id = p_group_id AND r.user_id = m.user_id 
                             AND r.response = 'yes'
                             AND r.responded_at > NOW() - INTERVAL '90 days'), 0), 1)
        END,
        m.host_private_note,
        m.joined_at
      FROM commander_home_members m
      LEFT JOIN profiles p ON p.id = m.user_id
     WHERE m.group_id = p_group_id
       AND m.status IN ('approved','pending')
     ORDER BY 
        CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
        m.is_regular DESC,
        COALESCE(m.games_attended, 0) DESC,
        m.joined_at;
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_home_group_member_engagement(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_home_group_member_engagement(uuid, uuid) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- Host diamond history
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_home_games_diamond_history(
    p_caller_user_id  uuid,
    p_limit           int DEFAULT 50
) RETURNS TABLE (
    txn_id uuid, amount int, created_at timestamptz,
    description text, game_id uuid, group_id uuid, attendees int
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    RETURN QUERY
    SELECT 
        dt.id, dt.amount, dt.created_at,
        dt.description,
        (dt.metadata->>'game_id')::uuid,
        (dt.metadata->>'group_id')::uuid,
        (dt.metadata->>'attendees')::int
      FROM diamond_transactions dt
     WHERE dt.user_id = p_caller_user_id
       AND dt.source = 'home_games'
     ORDER BY dt.created_at DESC
     LIMIT GREATEST(1, LEAST(p_limit, 200));
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_home_games_diamond_history(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_home_games_diamond_history(uuid, int) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- Export members CSV-formatted
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.export_home_group_members_csv(
    p_group_id        uuid,
    p_caller_user_id  uuid
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_group   RECORD;
    v_csv     text := '';
    v_member  RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF v_group.owner_id <> p_caller_user_id 
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = p_group_id AND user_id = p_caller_user_id
                          AND role = 'admin' AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    -- Header
    v_csv := 'display_name,username,email,role,status,is_regular,games_attended,flake_strikes,last_attended,joined_at' || chr(10);

    FOR v_member IN
        SELECT 
            COALESCE(p.display_name, p.full_name, '') AS display_name,
            COALESCE(p.username, '') AS username,
            COALESCE(au.email, '') AS email,
            m.role, m.status, 
            COALESCE(m.is_regular, false) AS is_regular,
            COALESCE(m.games_attended, 0) AS games_attended,
            COALESCE(m.flake_strikes, 0) AS flake_strikes,
            m.last_attended, m.joined_at
          FROM commander_home_members m
          LEFT JOIN profiles p ON p.id = m.user_id
          LEFT JOIN auth.users au ON au.id = m.user_id
         WHERE m.group_id = p_group_id
         ORDER BY m.joined_at
    LOOP
        v_csv := v_csv 
            || '"' || replace(v_member.display_name, '"', '""') || '",'
            || '"' || replace(v_member.username, '"', '""') || '",'
            || '"' || replace(v_member.email, '"', '""') || '",'
            || v_member.role || ','
            || v_member.status || ','
            || v_member.is_regular || ','
            || v_member.games_attended || ','
            || v_member.flake_strikes || ','
            || COALESCE(v_member.last_attended::text, '') || ','
            || COALESCE(v_member.joined_at::text, '')
            || chr(10);
    END LOOP;

    RETURN v_csv;
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.export_home_group_members_csv(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.export_home_group_members_csv(uuid, uuid) TO authenticated, service_role;
