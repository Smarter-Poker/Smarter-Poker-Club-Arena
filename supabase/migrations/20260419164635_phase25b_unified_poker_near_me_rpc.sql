-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419164635 "phase25b_unified_poker_near_me_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5652833dfa83e0e075660d22f98ae1d0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 25 PART B — Unified "Poker Near Me" map RPC
--  Merges poker_venues + public commander_home_groups onto one map feed
--  with distance filtering via PostGIS.
-- =========================================================================

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
    source           text,          -- 'venue' or 'home_group'
    entity_id        text,
    name             text,
    slug             text,
    venue_type       text,
    city             text,
    state            text,
    country          text,
    address          text,
    lat              numeric,
    lng              numeric,
    distance_miles   numeric,
    photo_url        text,
    is_verified      boolean,       -- for venues: is_claimed; for homes: photo+recent activity
    trust_score      integer,
    -- Venue extras
    stakes_cash      text,
    games_offered    text,
    poker_tables     integer,
    has_tournaments  boolean,
    accepts_home_games boolean,
    phone            text,
    website          text,
    -- Home-game extras
    is_private       boolean,
    member_count     integer,
    games_hosted     integer,
    last_activity_at timestamptz,
    -- Common
    tagline          text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_point       geography;
    v_radius_m    numeric;
BEGIN
    IF p_lat IS NULL OR p_lng IS NULL THEN RAISE EXCEPTION 'LAT_LNG_REQUIRED'; END IF;
    IF p_radius_miles <= 0 OR p_radius_miles > 500 THEN RAISE EXCEPTION 'INVALID_RADIUS'; END IF;

    v_point    := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
    v_radius_m := p_radius_miles * 1609.344;  -- miles → meters

    RETURN QUERY
    -- ═══════════════════════════════════════════════════════════════════
    -- Branch 1: Poker venues
    -- ═══════════════════════════════════════════════════════════════════
    SELECT 
        'venue'::text AS source,
        pv.id::text AS entity_id,
        pv.name,
        pv.slug,
        COALESCE(pv.venue_type, 'poker_room') AS venue_type,
        pv.city, pv.state, pv.country, pv.address,
        COALESCE(pv.lat, pv.latitude) AS lat,
        COALESCE(pv.lng, pv.longitude) AS lng,
        ROUND(
          (ST_Distance(
             ST_SetSRID(ST_MakePoint(COALESCE(pv.lng, pv.longitude), COALESCE(pv.lat, pv.latitude)), 4326)::geography,
             v_point
           ) / 1609.344)::numeric, 2
        ) AS distance_miles,
        COALESCE(pv.profile_photo_url, pv.cover_photo_url, pv.logo_url) AS photo_url,
        COALESCE(pv.is_claimed, false) AS is_verified,
        pv.trust_score,
        pv.stakes_cash, pv.games_offered, pv.poker_tables, 
        COALESCE(pv.has_tournaments, false),
        COALESCE(pv.accepts_home_games, false),
        pv.phone, pv.website,
        -- home-game-only defaults
        NULL::boolean, NULL::integer, NULL::integer, NULL::timestamptz,
        pv.tagline
      FROM poker_venues pv
     WHERE p_include_venues = true
       AND COALESCE(pv.is_active, true) = true
       AND COALESCE(pv.is_suppressed, false) = false
       AND COALESCE(pv.lat, pv.latitude) IS NOT NULL
       AND COALESCE(pv.lng, pv.longitude) IS NOT NULL
       AND ST_DWithin(
           ST_SetSRID(ST_MakePoint(COALESCE(pv.lng, pv.longitude), COALESCE(pv.lat, pv.latitude)), 4326)::geography,
           v_point, v_radius_m
       )
       AND (p_state_filter IS NULL OR pv.state = p_state_filter)

    UNION ALL

    -- ═══════════════════════════════════════════════════════════════════
    -- Branch 2: Public home groups
    -- ═══════════════════════════════════════════════════════════════════
    SELECT 
        'home_group'::text AS source,
        grp.id::text AS entity_id,
        grp.name,
        sp.slug,
        'home_game'::text AS venue_type,
        grp.city, grp.state, 'US'::text AS country, grp.address,
        grp.latitude AS lat, grp.longitude AS lng,
        ROUND(
          (ST_Distance(grp.location_geog, v_point) / 1609.344)::numeric, 2
        ) AS distance_miles,
        grp.profile_photo_url AS photo_url,
        (grp.profile_photo_url IS NOT NULL AND grp.last_activity_at > NOW() - INTERVAL '30 days') AS is_verified,
        NULL::integer AS trust_score,
        grp.default_stakes AS stakes_cash,
        grp.default_game_type AS games_offered,
        NULL::integer AS poker_tables,
        EXISTS (SELECT 1 FROM commander_home_games g 
                 WHERE g.group_id = grp.id AND g.format='tournament' 
                   AND g.scheduled_date >= CURRENT_DATE
                   AND g.status IN ('scheduled','confirmed'))
           AS has_tournaments,
        NULL::boolean AS accepts_home_games,
        NULL::text AS phone, NULL::text AS website,
        grp.is_private,
        grp.member_count,
        grp.games_hosted,
        grp.last_activity_at,
        grp.tagline
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

     ORDER BY distance_miles
     LIMIT GREATEST(1, LEAST(p_limit, 500));
END;
$fn$;

COMMENT ON FUNCTION public.get_poker_near_me_unified(numeric,numeric,numeric,boolean,boolean,text,int,int) IS
  'Phase 25/B: Unified Poker Near Me map feed. Returns poker venues + public home groups within radius, sorted by distance.';

REVOKE EXECUTE ON FUNCTION public.get_poker_near_me_unified(numeric,numeric,numeric,boolean,boolean,text,int,int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_poker_near_me_unified(numeric,numeric,numeric,boolean,boolean,text,int,int) TO anon, authenticated, service_role;
