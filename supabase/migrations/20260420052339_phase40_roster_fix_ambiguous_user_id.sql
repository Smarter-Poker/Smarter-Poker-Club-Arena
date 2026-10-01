-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420052339 "phase40_roster_fix_ambiguous_user_id"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6732f948ff5931657193d07d5aa7547e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.get_home_group_roster(
    p_group_id uuid,
    p_caller_user_id uuid
)
RETURNS TABLE (
    user_id              uuid,
    username             text,
    display_name         text,
    avatar_url           text,
    relationship         text,
    member_role          text,
    member_status        text,
    member_joined_at     timestamptz,
    follower_since       timestamptz,
    notify_new_games     boolean,
    notify_announcements boolean,
    checked_in_games     int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $fn$
#variable_conflict use_column
DECLARE
    v_caller uuid := auth.uid();
    v_role   text := auth.role();
    v_is_staff boolean;
BEGIN
    IF v_role <> 'service_role' THEN
      IF v_caller IS NULL OR v_caller <> p_caller_user_id THEN
        RAISE EXCEPTION 'AUTH_MISMATCH';
      END IF;
    END IF;

    SELECT
      EXISTS (SELECT 1 FROM commander_home_groups g
               WHERE g.id = p_group_id AND g.owner_id = p_caller_user_id)
      OR EXISTS (SELECT 1 FROM commander_home_members m
                  WHERE m.group_id = p_group_id AND m.user_id = p_caller_user_id
                    AND m.role = 'admin' AND m.status = 'approved')
    INTO v_is_staff;

    IF NOT v_is_staff THEN
      RAISE EXCEPTION 'NOT_AUTHORIZED'
            USING HINT='only group owner or approved admin may view the roster';
    END IF;

    RETURN QUERY
    WITH unified AS (
        SELECT m.user_id,
               'member'::text AS src,
               m.role AS m_role,
               m.status AS m_status,
               m.joined_at AS m_joined,
               NULL::timestamptz AS f_since,
               COALESCE(m.notify_new_games, true) AS m_notify_games,
               COALESCE(m.notify_announcements, true) AS m_notify_ann
          FROM commander_home_members m
         WHERE m.group_id = p_group_id

        UNION ALL

        SELECT f.user_id,
               'follower'::text AS src,
               NULL::text AS m_role,
               NULL::text AS m_status,
               NULL::timestamptz AS m_joined,
               f.created_at AS f_since,
               f.notify_new_games AS m_notify_games,
               f.notify_announcements AS m_notify_ann
          FROM commander_home_group_follows f
         WHERE f.group_id = p_group_id
    ),
    collapsed AS (
        SELECT u.user_id,
               CASE
                 WHEN bool_or(u.src='member') AND bool_or(u.src='follower') THEN 'both'
                 WHEN bool_or(u.src='member')   THEN 'member'
                 ELSE 'follower'
               END AS relationship,
               MAX(CASE WHEN u.src='member' THEN u.m_role   END) AS member_role,
               MAX(CASE WHEN u.src='member' THEN u.m_status END) AS member_status,
               MAX(CASE WHEN u.src='member' THEN u.m_joined END) AS member_joined_at,
               MAX(CASE WHEN u.src='follower' THEN u.f_since END) AS follower_since,
               bool_or(u.m_notify_games)  AS notify_new_games,
               bool_or(u.m_notify_ann)    AS notify_announcements
          FROM unified u
         GROUP BY u.user_id
    )
    SELECT c.user_id,
           p.username,
           COALESCE(p.display_name, p.full_name, p.username) AS display_name,
           p.avatar_url,
           c.relationship,
           c.member_role,
           c.member_status,
           c.member_joined_at,
           c.follower_since,
           c.notify_new_games,
           c.notify_announcements,
           (
              SELECT COUNT(*)::int
                FROM commander_home_rsvps r
                JOIN commander_home_games g ON g.id = r.game_id
               WHERE g.group_id = p_group_id
                 AND r.user_id = c.user_id
                 AND r.checked_in_at IS NOT NULL
           ) AS checked_in_games
      FROM collapsed c
      JOIN profiles p ON p.id = c.user_id
     ORDER BY
        (c.member_status = 'banned') ASC,
        c.relationship = 'follower',
        COALESCE(c.member_joined_at, c.follower_since) DESC;
END;
$fn$;
