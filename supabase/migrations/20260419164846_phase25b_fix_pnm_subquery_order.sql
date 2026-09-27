-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419164846 "phase25b_fix_pnm_subquery_order"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 aea8e35cd00b69e1c2fb5c76ae149bdb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.get_poker_near_me_unified(
    p_lat               numeric,
    p_lng               numeric,
    p_radius_miles      numeric DEFAULT 50,
    p_include_venues    boolean DEFAULT true,
    p_include_home_games boolean DEFAULT true,
    p_state_filter      text DEFAULT NULL,
    p_inactivity_days   int DEFAULT 45,
    p_limit             int DEFAULT 200
) RETURNS TABLE (
    source text, entity_id text, name text, slug text, venue_type text,
    city text, state text, country text, address text,
    lat numeric, lng numeric, distance_miles numeric,
    photo_url text, is_verified boolean, trust_score integer,
    stakes_cash text, games_offered text, poker_tables integer,
    has_tournaments boolean, accepts_home_games boolean,
    phone text, website text,
    is_private boolean, member_count integer, games_hosted integer,
    last_activity_at timestamptz, tagline text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_point geography; v_radius_m numeric;
BEGIN
    IF p_lat IS NULL OR p_lng IS NULL THEN RAISE EXCEPTION 'LAT_LNG_REQUIRED'; END IF;
    IF p_radius_miles <= 0 OR p_radius_miles > 500 THEN RAISE EXCEPTION 'INVALID_RADIUS'; END IF;
    v_point    := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
    v_radius_m := p_radius_miles * 1609.344;

    RETURN QUERY
    SELECT * FROM (
      SELECT 'venue'::text AS src, pv.id::text AS eid, pv.name AS nm, pv.slug AS sg,
             COALESCE(pv.venue_type, 'poker_room') AS vt,
             pv.city AS cy, pv.state AS st, pv.country AS co, pv.address AS ad,
             COALESCE(pv.lat, pv.latitude) AS la, COALESCE(pv.lng, pv.longitude) AS lo,
             ROUND((ST_Distance(ST_SetSRID(ST_MakePoint(COALESCE(pv.lng, pv.longitude), COALESCE(pv.lat, pv.latitude)), 4326)::geography, v_point) / 1609.344)::numeric, 2) AS dm,
             COALESCE(pv.profile_photo_url, pv.cover_photo_url, pv.logo_url) AS ph,
             COALESCE(pv.is_claimed, false) AS iv, pv.trust_score AS ts,
             array_to_string(pv.stakes_cash, ', ') AS sc,
             array_to_string(pv.games_offered, ', ') AS go,
             pv.poker_tables AS pt,
             COALESCE(pv.has_tournaments, false) AS ht,
             COALESCE(pv.accepts_home_games, false) AS ahg,
             pv.phone AS phn, pv.website AS ws,
             NULL::boolean AS ipv, NULL::integer AS mc, NULL::integer AS gh,
             NULL::timestamptz AS laa, pv.tagline AS tgl
        FROM poker_venues pv
       WHERE p_include_venues = true
         AND COALESCE(pv.is_active, true) = true
         AND COALESCE(pv.is_suppressed, false) = false
         AND COALESCE(pv.lat, pv.latitude) IS NOT NULL
         AND COALESCE(pv.lng, pv.longitude) IS NOT NULL
         AND ST_DWithin(
             ST_SetSRID(ST_MakePoint(COALESCE(pv.lng, pv.longitude), COALESCE(pv.lat, pv.latitude)), 4326)::geography,
             v_point, v_radius_m)
         AND (p_state_filter IS NULL OR pv.state = p_state_filter)
      UNION ALL
      SELECT 'home_group'::text, grp.id::text, grp.name, sp.slug, 'home_game'::text,
             grp.city, grp.state, 'US'::text, NULL::text,
             grp.latitude, grp.longitude,
             ROUND((ST_Distance(grp.location_geog, v_point) / 1609.344)::numeric, 2),
             grp.profile_photo_url,
             (grp.profile_photo_url IS NOT NULL AND grp.last_activity_at > NOW() - INTERVAL '30 days'),
             NULL::integer,
             grp.default_stakes, grp.default_game_type, NULL::integer,
             EXISTS (SELECT 1 FROM commander_home_games g 
                      WHERE g.group_id = grp.id AND g.format='tournament' 
                        AND g.scheduled_date >= CURRENT_DATE
                        AND g.status IN ('scheduled','confirmed')),
             NULL::boolean,
             NULL::text, NULL::text,
             grp.is_private, grp.member_count, grp.games_hosted,
             grp.last_activity_at, grp.tagline
        FROM commander_home_groups grp
        LEFT JOIN social_pages sp ON sp.linked_entity_type='home_group' AND sp.linked_entity_id = grp.id::text
       WHERE p_include_home_games = true
         AND grp.is_active = true
         AND NOT grp.is_private
         AND grp.profile_photo_url IS NOT NULL
         AND grp.last_activity_at > NOW() - (p_inactivity_days || ' days')::interval
         AND grp.location_geog IS NOT NULL
         AND ST_DWithin(grp.location_geog, v_point, v_radius_m)
         AND (p_state_filter IS NULL OR grp.state = p_state_filter)
    ) merged
    ORDER BY merged.dm
    LIMIT GREATEST(1, LEAST(p_limit, 500));
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.get_poker_near_me_unified(numeric,numeric,numeric,boolean,boolean,text,int,int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_poker_near_me_unified(numeric,numeric,numeric,boolean,boolean,text,int,int) TO anon, authenticated, service_role;
