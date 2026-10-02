-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419221022 "phase34_fix_get_home_group_member_engagement"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ffd75153f4fccc66021dbe89329c17b9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 34: Fix get_home_group_member_engagement — RETURN TABLE(user_id uuid...)
-- conflicts with commander_home_members.user_id in the EXISTS subquery.
-- Fix: fully qualify all column references with table aliases.

CREATE OR REPLACE FUNCTION public.get_home_group_member_engagement(
    p_group_id uuid, p_caller_user_id uuid
) RETURNS TABLE(
    user_id uuid, display_name text, avatar_url text, role text, status text,
    is_regular boolean, games_attended integer, games_attended_90d bigint,
    rsvps_yes_90d bigint, rsvps_no_90d bigint, flake_strikes integer,
    last_attended timestamp with time zone, last_rsvp_at timestamp with time zone,
    rsvp_flake_rate_pct numeric, host_private_note text, joined_at timestamp with time zone
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_group RECORD;
BEGIN
    IF auth.role() <> 'service_role' 
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;
    SELECT * INTO v_group FROM commander_home_groups cg WHERE cg.id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF v_group.owner_id <> p_caller_user_id 
       AND NOT EXISTS (SELECT 1 FROM commander_home_members mm
                        WHERE mm.group_id = p_group_id 
                          AND mm.user_id = p_caller_user_id
                          AND mm.role = 'admin' AND mm.status = 'approved')
    THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    RETURN QUERY
    SELECT 
        m.user_id,
        COALESCE(p.display_name, p.full_name, p.username, 'Member')::text AS display_name,
        p.avatar_url,
        m.role,
        m.status,
        COALESCE(m.is_regular, false) AS is_regular,
        COALESCE(m.games_attended, 0) AS games_attended,
        COALESCE((SELECT COUNT(*) FROM commander_home_rsvps r 
                   JOIN commander_home_games g ON g.id = r.game_id
                   WHERE g.group_id = p_group_id AND r.user_id = m.user_id 
                     AND r.checked_in_at IS NOT NULL
                     AND r.checked_in_at > NOW() - INTERVAL '90 days'), 0) AS games_attended_90d,
        COALESCE((SELECT COUNT(*) FROM commander_home_rsvps r 
                   JOIN commander_home_games g ON g.id = r.game_id
                   WHERE g.group_id = p_group_id AND r.user_id = m.user_id 
                     AND r.response = 'yes'
                     AND r.responded_at > NOW() - INTERVAL '90 days'), 0) AS rsvps_yes_90d,
        COALESCE((SELECT COUNT(*) FROM commander_home_rsvps r 
                   JOIN commander_home_games g ON g.id = r.game_id
                   WHERE g.group_id = p_group_id AND r.user_id = m.user_id 
                     AND r.response = 'no'
                     AND r.responded_at > NOW() - INTERVAL '90 days'), 0) AS rsvps_no_90d,
        COALESCE(m.flake_strikes, 0) AS flake_strikes,
        m.last_attended,
        (SELECT MAX(r.responded_at) FROM commander_home_rsvps r 
           JOIN commander_home_games g ON g.id = r.game_id
          WHERE g.group_id = p_group_id AND r.user_id = m.user_id) AS last_rsvp_at,
        CASE 
            WHEN COALESCE((SELECT COUNT(*) FROM commander_home_rsvps r 
                            JOIN commander_home_games g ON g.id = r.game_id
                            WHERE g.group_id = p_group_id AND r.user_id = m.user_id 
                              AND r.response = 'yes'
                              AND r.responded_at > NOW() - INTERVAL '90 days'), 0) = 0 THEN 0
            ELSE ROUND(100.0 * 
                COALESCE((SELECT COUNT(*) FROM commander_home_rsvps r 
                           JOIN commander_home_games g ON g.id = r.game_id
                           WHERE g.group_id = p_group_id AND r.user_id = m.user_id 
                             AND r.flaked = true
                             AND r.responded_at > NOW() - INTERVAL '90 days'), 0)::numeric
                / NULLIF((SELECT COUNT(*) FROM commander_home_rsvps r 
                           JOIN commander_home_games g ON g.id = r.game_id
                           WHERE g.group_id = p_group_id AND r.user_id = m.user_id 
                             AND r.response = 'yes'
                             AND r.responded_at > NOW() - INTERVAL '90 days'), 0), 1)
        END AS rsvp_flake_rate_pct,
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

GRANT EXECUTE ON FUNCTION public.get_home_group_member_engagement(uuid, uuid) TO authenticated, service_role;
