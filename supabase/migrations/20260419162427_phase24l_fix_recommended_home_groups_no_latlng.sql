-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419162427 "phase24l_fix_recommended_home_groups_no_latlng"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b137f3b17fc371c86d9e082d08101e05 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: profiles only has city + state, no lat/lng. Remove geo distance scoring.
CREATE OR REPLACE FUNCTION public.get_recommended_home_groups(
    p_caller_user_id  uuid,
    p_limit           int DEFAULT 10
) RETURNS TABLE (
    group_id uuid, name text, slug text,
    city text, state text, profile_photo_url text,
    member_count int, friends_in_group bigint,
    recommendation_score numeric, reason text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_user_city  text;
    v_user_state text;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;

    SELECT city, state INTO v_user_city, v_user_state
      FROM profiles WHERE id = p_caller_user_id;

    RETURN QUERY
    WITH friend_groups AS (
      SELECT m.group_id, COUNT(DISTINCT m.user_id) AS friend_count
        FROM commander_home_members m
       WHERE m.user_id IN (
           SELECT DISTINCT CASE WHEN f.user_id = p_caller_user_id THEN f.friend_id ELSE f.user_id END
             FROM friendships f
            WHERE (f.user_id = p_caller_user_id OR f.friend_id = p_caller_user_id)
              AND f.status = 'accepted'
       )
       AND m.status = 'approved'
       GROUP BY m.group_id
    ),
    scored AS (
      SELECT 
        g.id, g.name, sp.slug, g.city, g.state, g.profile_photo_url,
        COALESCE(g.member_count, 0) AS member_count,
        COALESCE(fg.friend_count, 0) AS friends_in_group,
        (COALESCE(fg.friend_count, 0) * 30
         + CASE WHEN v_user_city IS NOT NULL AND g.city ILIKE v_user_city THEN 20 ELSE 0 END
         + CASE WHEN v_user_state IS NOT NULL AND g.state = v_user_state THEN 10 ELSE 0 END
         + LEAST(10, COALESCE(g.games_hosted, 0)) * 0.5
         + LEAST(5, COALESCE(g.view_count, 0) / 100.0)
        )::numeric AS score,
        CASE 
          WHEN COALESCE(fg.friend_count, 0) > 0 
            THEN fg.friend_count || ' friend' || CASE WHEN fg.friend_count > 1 THEN 's' ELSE '' END || ' in this group'
          WHEN v_user_city IS NOT NULL AND g.city ILIKE v_user_city 
            THEN 'In your city: ' || g.city
          WHEN v_user_state IS NOT NULL AND g.state = v_user_state 
            THEN 'In your state'
          ELSE 'Active home game'
        END AS reason
        FROM commander_home_groups g
        LEFT JOIN friend_groups fg ON fg.group_id = g.id
        LEFT JOIN social_pages sp ON sp.linked_entity_type='home_group' AND sp.linked_entity_id = g.id::text
       WHERE g.is_active = true
         AND NOT g.is_private
         AND g.profile_photo_url IS NOT NULL
         AND g.last_activity_at > NOW() - INTERVAL '45 days'
         AND NOT EXISTS (SELECT 1 FROM commander_home_members m 
                          WHERE m.group_id = g.id AND m.user_id = p_caller_user_id)
         AND g.owner_id <> p_caller_user_id
    )
    SELECT s.id, s.name, s.slug, s.city, s.state, s.profile_photo_url,
           s.member_count, s.friends_in_group, s.score, s.reason
      FROM scored s
     ORDER BY s.score DESC
     LIMIT GREATEST(1, LEAST(p_limit, 50));
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_recommended_home_groups(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_recommended_home_groups(uuid, int) TO authenticated, service_role;
