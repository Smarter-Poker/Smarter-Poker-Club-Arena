-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420010548 "phase40_fix_search_home_groups_v1_viewer_impersonation"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1ef666707bac84f66d3bda96183b5b40 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- search_home_groups (v1) — same viewer-impersonation fix as v2

CREATE OR REPLACE FUNCTION public.search_home_groups(
  p_search_text text DEFAULT NULL::text,
  p_city text DEFAULT NULL::text,
  p_state text DEFAULT NULL::text,
  p_game_type text DEFAULT NULL::text,
  p_stakes text DEFAULT NULL::text,
  p_lat double precision DEFAULT NULL::double precision,
  p_lng double precision DEFAULT NULL::double precision,
  p_radius_miles numeric DEFAULT NULL::numeric,
  p_exclude_joined boolean DEFAULT true,
  p_viewer_user_id uuid DEFAULT NULL::uuid,
  p_limit integer DEFAULT 50,
  p_inactivity_days integer DEFAULT 45
)
RETURNS TABLE(
  group_id uuid, slug text, name text, tagline text, profile_photo_url text,
  city text, state text, default_game_type text, default_stakes text,
  typical_buyin_min integer, typical_buyin_max integer, max_players integer,
  frequency text, member_count integer, last_activity_at timestamp with time zone,
  distance_miles numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
    -- Phase 40: prevent viewer_id impersonation / membership enumeration
    IF p_viewer_user_id IS NOT NULL THEN
      IF COALESCE(auth.role(), '') <> 'service_role' THEN
        IF auth.uid() IS NULL OR auth.uid() <> p_viewer_user_id THEN
          RAISE EXCEPTION 'VIEWER_ID_MISMATCH'
                USING ERRCODE = '42501',
                      HINT = 'p_viewer_user_id must equal auth.uid() or be null';
        END IF;
      END IF;
    END IF;

    p_limit := LEAST(COALESCE(p_limit, 50), 100);

    RETURN QUERY
    WITH base AS (
        SELECT g.*,
               sp.slug,
               CASE
                 WHEN p_lat IS NULL OR p_lng IS NULL
                      OR g.latitude IS NULL OR g.longitude IS NULL
                 THEN NULL::numeric
                 ELSE ROUND((
                    3959 * acos(
                        LEAST(1,
                            cos(radians(p_lat)) * cos(radians(g.latitude)) *
                            cos(radians(g.longitude) - radians(p_lng)) +
                            sin(radians(p_lat)) * sin(radians(g.latitude))
                        )
                    )
                 )::numeric, 1)
               END AS dist
          FROM commander_home_groups g
          LEFT JOIN social_pages sp
            ON sp.linked_entity_type = 'home_group'
           AND sp.linked_entity_id = g.id::text
         WHERE g.is_private = false
           AND g.is_active  = true
           AND (
               (g.visibility_override_until IS NOT NULL AND g.visibility_override_until > NOW())
            OR (g.last_activity_at IS NOT NULL
                AND g.last_activity_at >= NOW() - (p_inactivity_days || ' days')::interval)
           )
    )
    SELECT
        b.id, b.slug::text, b.name::text, b.tagline::text,
        b.profile_photo_url::text,
        b.city::text, b.state::text,
        b.default_game_type::text, b.default_stakes::text,
        b.typical_buyin_min, b.typical_buyin_max, b.max_players,
        b.frequency::text, b.member_count, b.last_activity_at,
        b.dist
      FROM base b
     WHERE (p_search_text IS NULL
            OR b.name        ILIKE '%' || p_search_text || '%'
            OR b.tagline     ILIKE '%' || p_search_text || '%'
            OR b.description ILIKE '%' || p_search_text || '%'
            OR b.city        ILIKE '%' || p_search_text || '%')
       AND (p_city      IS NULL OR b.city ILIKE p_city)
       AND (p_state     IS NULL OR UPPER(b.state) = UPPER(p_state))
       AND (p_game_type IS NULL OR b.default_game_type ILIKE p_game_type)
       AND (p_stakes    IS NULL OR b.default_stakes ILIKE '%' || p_stakes || '%')
       AND (p_radius_miles IS NULL OR b.dist IS NULL OR b.dist <= p_radius_miles)
       AND (
           p_exclude_joined = false
           OR p_viewer_user_id IS NULL
           OR NOT EXISTS (
               SELECT 1 FROM commander_home_members m
                WHERE m.group_id = b.id
                  AND m.user_id = p_viewer_user_id
                  AND m.status IN ('approved','pending')
           )
           AND b.owner_id <> p_viewer_user_id
       )
     ORDER BY
        CASE WHEN p_lat IS NULL THEN 1 ELSE 0 END,
        b.dist NULLS LAST,
        b.last_activity_at DESC NULLS LAST
     LIMIT p_limit;
END;
$function$;

COMMENT ON FUNCTION public.search_home_groups IS
  'Phase 40: validates p_viewer_user_id = auth.uid() to prevent membership '
  'enumeration via exclude_joined diff. service_role bypass for cron.';
