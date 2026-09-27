-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419220125 "phase34_home_games_complete_lockdown_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b46216bdc8c402a5884a0e8d14cdf151 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
-- PHASE 34 — HOME GAMES COMPLETE LOCKDOWN (v2: correct column name)
-- ══════════════════════════════════════════════════════════════════════════

-- 1. Missing composite index on commander_home_games
CREATE INDEX IF NOT EXISTS idx_commander_home_games_group_scheduled
  ON commander_home_games (group_id, scheduled_date DESC, start_time DESC);

-- 2. fn_home_assign_seat — add auth.uid guard
CREATE OR REPLACE FUNCTION public.fn_home_assign_seat(
    p_caller uuid, p_game_id uuid, p_seat_number integer,
    p_user_id uuid DEFAULT NULL, p_player_name text DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_exists boolean;
BEGIN
    IF auth.role() <> 'service_role' 
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'unauthorized: caller identity mismatch');
    END IF;
    IF NOT fn_home_caller_is_game_staff(p_caller, p_game_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not authorized');
    END IF;
    IF p_seat_number IS NULL OR p_seat_number < 1 OR p_seat_number > 12 THEN
        RETURN jsonb_build_object('success', false, 'error', 'seat_number must be 1..12');
    END IF;
    IF p_user_id IS NULL AND (p_player_name IS NULL OR LENGTH(TRIM(p_player_name)) = 0) THEN
        RETURN jsonb_build_object('success', false, 'error', 'either user_id or player_name required');
    END IF;

    SELECT EXISTS (SELECT 1 FROM commander_home_seats
                    WHERE game_id = p_game_id AND seat_number = p_seat_number) INTO v_exists;
    IF NOT v_exists THEN
        INSERT INTO commander_home_seats (game_id, seat_number) VALUES (p_game_id, p_seat_number);
    END IF;

    IF p_user_id IS NOT NULL THEN
        UPDATE commander_home_seats
           SET user_id = NULL, player_name = NULL, status = 'empty',
               seated_at = NULL, away_since = NULL, note = NULL, updated_at = NOW()
         WHERE game_id = p_game_id AND user_id = p_user_id AND seat_number <> p_seat_number;
    END IF;

    UPDATE commander_home_seats
       SET user_id = p_user_id, player_name = p_player_name, status = 'seated',
           seated_at = COALESCE(seated_at, NOW()), away_since = NULL,
           note = p_note, updated_at = NOW()
     WHERE game_id = p_game_id AND seat_number = p_seat_number;

    RETURN jsonb_build_object('success', true, 'game_id', p_game_id, 'seat_number', p_seat_number);
END;
$fn$;

-- 3. fn_home_init_seats
CREATE OR REPLACE FUNCTION public.fn_home_init_seats(
    p_caller uuid, p_game_id uuid, p_max_players integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_max integer; v_created integer := 0;
BEGIN
    IF auth.role() <> 'service_role' 
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'unauthorized: caller identity mismatch');
    END IF;
    IF NOT fn_home_caller_is_game_staff(p_caller, p_game_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not authorized');
    END IF;
    IF p_max_players IS NULL THEN
        SELECT max_players INTO v_max FROM commander_home_games WHERE id = p_game_id;
    ELSE v_max := p_max_players;
    END IF;
    IF v_max IS NULL OR v_max < 1 OR v_max > 12 THEN
        RETURN jsonb_build_object('success', false, 'error', 'max_players must be 1..12');
    END IF;
    WITH want AS (SELECT generate_series(1, v_max) AS n),
         ins AS (INSERT INTO commander_home_seats (game_id, seat_number)
                 SELECT p_game_id, w.n FROM want w
                 ON CONFLICT (game_id, seat_number) DO NOTHING RETURNING 1)
    SELECT COUNT(*) INTO v_created FROM ins;
    RETURN jsonb_build_object('success', true, 'game_id', p_game_id,
        'max_players', v_max, 'seats_created', v_created);
END;
$fn$;

-- 4. fn_home_move_seat
CREATE OR REPLACE FUNCTION public.fn_home_move_seat(
    p_caller uuid, p_game_id uuid, p_from_seat integer, p_to_seat integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE r_from commander_home_seats%ROWTYPE; r_to commander_home_seats%ROWTYPE;
BEGIN
    IF auth.role() <> 'service_role' 
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'unauthorized: caller identity mismatch');
    END IF;
    IF NOT fn_home_caller_is_game_staff(p_caller, p_game_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not authorized');
    END IF;
    IF p_from_seat = p_to_seat THEN
        RETURN jsonb_build_object('success', true, 'noop', true);
    END IF;
    SELECT * INTO r_from FROM commander_home_seats
     WHERE game_id = p_game_id AND seat_number = p_from_seat FOR UPDATE;
    SELECT * INTO r_to FROM commander_home_seats
     WHERE game_id = p_game_id AND seat_number = p_to_seat FOR UPDATE;
    IF r_from.id IS NULL OR r_to.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'seat(s) not found');
    END IF;
    UPDATE commander_home_seats SET user_id = NULL, updated_at = NOW() WHERE id = r_from.id;
    UPDATE commander_home_seats
       SET user_id = r_from.user_id, player_name = r_from.player_name,
           status = r_from.status, seated_at = r_from.seated_at,
           away_since = r_from.away_since, note = r_from.note, updated_at = NOW()
     WHERE id = r_to.id;
    UPDATE commander_home_seats
       SET user_id = r_to.user_id, player_name = r_to.player_name,
           status = r_to.status, seated_at = r_to.seated_at,
           away_since = r_to.away_since, note = r_to.note, updated_at = NOW()
     WHERE id = r_from.id;
    RETURN jsonb_build_object('success', true, 'game_id', p_game_id,
        'from', p_from_seat, 'to', p_to_seat);
END;
$fn$;

-- 5. fn_home_randomize_seats
CREATE OR REPLACE FUNCTION public.fn_home_randomize_seats(p_caller uuid, p_game_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_assigned integer := 0;
BEGIN
    IF auth.role() <> 'service_role' 
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'unauthorized: caller identity mismatch');
    END IF;
    IF NOT fn_home_caller_is_game_staff(p_caller, p_game_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not authorized');
    END IF;
    WITH candidates AS (
        SELECT r.user_id FROM commander_home_rsvps r
         WHERE r.game_id = p_game_id AND r.is_confirmed = true AND r.response = 'yes'
           AND NOT EXISTS (SELECT 1 FROM commander_home_seats s
                            WHERE s.game_id = p_game_id AND s.user_id = r.user_id)
         ORDER BY random()
    ),
    empties AS (SELECT seat_number FROM commander_home_seats
                 WHERE game_id = p_game_id AND user_id IS NULL AND status = 'empty'
                 ORDER BY seat_number),
    pairs AS (SELECT c.user_id, e.seat_number FROM
              (SELECT user_id, ROW_NUMBER() OVER () AS rn FROM candidates) c
              JOIN (SELECT seat_number, ROW_NUMBER() OVER () AS rn FROM empties) e
                ON c.rn = e.rn),
    upd AS (UPDATE commander_home_seats s
               SET user_id = p.user_id, status = 'seated',
                   seated_at = NOW(), updated_at = NOW()
              FROM pairs p
             WHERE s.game_id = p_game_id AND s.seat_number = p.seat_number
            RETURNING 1)
    SELECT COUNT(*) INTO v_assigned FROM upd;
    RETURN jsonb_build_object('success', true, 'game_id', p_game_id, 'assigned', v_assigned);
END;
$fn$;

-- 6. fn_home_set_seat_status
CREATE OR REPLACE FUNCTION public.fn_home_set_seat_status(
    p_caller uuid, p_game_id uuid, p_seat_number integer, p_status text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
    IF auth.role() <> 'service_role' 
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'unauthorized: caller identity mismatch');
    END IF;
    IF NOT fn_home_caller_is_game_staff(p_caller, p_game_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not authorized');
    END IF;
    IF p_status NOT IN ('empty','reserved','seated','away') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid status');
    END IF;
    UPDATE commander_home_seats
       SET status = p_status,
           seated_at = CASE WHEN p_status='seated' THEN COALESCE(seated_at, NOW()) ELSE seated_at END,
           away_since = CASE WHEN p_status='away' THEN NOW() ELSE NULL END,
           updated_at = NOW()
     WHERE game_id = p_game_id AND seat_number = p_seat_number;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'seat not found');
    END IF;
    RETURN jsonb_build_object('success', true);
END;
$fn$;

-- 7. fn_home_vacate_seat
CREATE OR REPLACE FUNCTION public.fn_home_vacate_seat(
    p_caller uuid, p_game_id uuid, p_seat_number integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
    IF auth.role() <> 'service_role' 
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'unauthorized: caller identity mismatch');
    END IF;
    IF NOT fn_home_caller_is_game_staff(p_caller, p_game_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not authorized');
    END IF;
    UPDATE commander_home_seats
       SET user_id = NULL, player_name = NULL, status = 'empty',
           seated_at = NULL, away_since = NULL, note = NULL, updated_at = NOW()
     WHERE game_id = p_game_id AND seat_number = p_seat_number;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'seat not found');
    END IF;
    RETURN jsonb_build_object('success', true, 'game_id', p_game_id, 'seat_number', p_seat_number);
END;
$fn$;

-- 8. revive_home_group
CREATE OR REPLACE FUNCTION public.revive_home_group(p_group_id uuid, p_caller_user_id uuid)
RETURNS timestamp with time zone
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE g_owner_id uuid; g_is_active boolean; new_ts timestamptz;
BEGIN
    IF auth.role() <> 'service_role' 
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_caller_user_id) THEN
        RAISE EXCEPTION 'revive_home_group: caller identity mismatch' USING ERRCODE = '42501';
    END IF;
    IF p_group_id IS NULL OR p_caller_user_id IS NULL THEN
        RAISE EXCEPTION 'revive_home_group: both p_group_id and p_caller_user_id are required'
          USING ERRCODE = '22004';
    END IF;
    SELECT owner_id, is_active INTO g_owner_id, g_is_active
      FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'revive_home_group: home group % not found', p_group_id USING ERRCODE = 'P0002';
    END IF;
    IF NOT g_is_active THEN
        RAISE EXCEPTION 'revive_home_group: group is deactivated and cannot be revived by host' USING ERRCODE = '22023';
    END IF;
    IF p_caller_user_id <> g_owner_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members m
                        WHERE m.group_id = p_group_id AND m.user_id = p_caller_user_id
                          AND m.status = 'approved' AND m.role = 'admin') THEN
        RAISE EXCEPTION 'revive_home_group: caller is not authorized for this group' USING ERRCODE = '42501';
    END IF;
    UPDATE commander_home_groups
       SET last_activity_at = NOW(), updated_at = NOW()
     WHERE id = p_group_id
     RETURNING last_activity_at INTO new_ts;
    RETURN new_ts;
END;
$fn$;

-- 9. Grants: 7 fixed + 3 restored
GRANT EXECUTE ON FUNCTION public.fn_home_assign_seat(uuid, uuid, integer, uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_home_init_seats(uuid, uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_home_move_seat(uuid, uuid, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_home_randomize_seats(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_home_set_seat_status(uuid, uuid, integer, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_home_vacate_seat(uuid, uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revive_home_group(uuid, uuid) TO authenticated, service_role;

DO $$
DECLARE r RECORD; v_sig text;
BEGIN
    FOR r IN 
        SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname='public'
           AND p.proname IN ('claim_home_game_seat','redeem_home_group_invite_token',
                             'transfer_home_group_ownership')
    LOOP
        v_sig := 'public.' || quote_ident(r.proname) || '(' || r.args || ')';
        EXECUTE 'GRANT EXECUTE ON FUNCTION ' || v_sig || ' TO authenticated, service_role';
    END LOOP;
END $$;
