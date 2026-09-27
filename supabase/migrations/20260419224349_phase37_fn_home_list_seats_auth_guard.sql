-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419224349 "phase37_fn_home_list_seats_auth_guard"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ce58804f8a53b2f89bca3126b716ef43 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- H2. fn_home_list_seats — add caller-must-be-approved-member auth guard.
-- ============================================================================
-- Prior: anon-callable with only a p_game_id arg; anyone with a game UUID
-- could enumerate seated players + their seat notes.
-- After: service_role bypass OR caller must be approved member of the game's
-- owning group. Zero server fns call this (verified), and the frontend
-- consumes seat data via get_home_game_seat_map / get_live_home_game_state,
-- so tightening is safe.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_home_list_seats(p_game_id uuid)
 RETURNS TABLE(
    seat_number integer, status text, user_id uuid, username text,
    display_name text, avatar_url text, player_name text,
    seated_at timestamp with time zone, away_since timestamp with time zone, note text
 )
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
    v_group_id uuid;
    v_caller uuid := auth.uid();
BEGIN
    -- Service_role path: skip auth (server-side/cron/admin tooling)
    IF auth.role() = 'service_role' THEN
        RETURN QUERY
        SELECT s.seat_number, s.status, s.user_id, p.username,
               COALESCE(p.display_name, p.full_name, p.username) AS display_name,
               p.avatar_url, s.player_name, s.seated_at, s.away_since, s.note
          FROM commander_home_seats s
          LEFT JOIN profiles p ON p.id = s.user_id
         WHERE s.game_id = p_game_id
         ORDER BY s.seat_number;
        RETURN;
    END IF;

    -- Authenticated path: caller must be approved member of the group
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT g.group_id INTO v_group_id
      FROM commander_home_games g WHERE g.id = p_game_id;
    IF v_group_id IS NULL THEN
        RAISE EXCEPTION 'GAME_NOT_FOUND';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM commander_home_members m
         WHERE m.group_id = v_group_id
           AND m.user_id  = v_caller
           AND m.status   = 'approved'
    ) THEN
        RAISE EXCEPTION 'NOT_A_GROUP_MEMBER';
    END IF;

    RETURN QUERY
    SELECT s.seat_number, s.status, s.user_id, p.username,
           COALESCE(p.display_name, p.full_name, p.username) AS display_name,
           p.avatar_url, s.player_name, s.seated_at, s.away_since, s.note
      FROM commander_home_seats s
      LEFT JOIN profiles p ON p.id = s.user_id
     WHERE s.game_id = p_game_id
     ORDER BY s.seat_number;
END;
$function$;

-- Lock down grants: anon is OUT, authenticated + service_role IN
REVOKE EXECUTE ON FUNCTION public.fn_home_list_seats(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_home_list_seats(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_home_list_seats(uuid) IS
    'Returns seat map for a home game. Phase 37: added auth guard — caller '
    'must be service_role or an approved member of the game''s group.';
