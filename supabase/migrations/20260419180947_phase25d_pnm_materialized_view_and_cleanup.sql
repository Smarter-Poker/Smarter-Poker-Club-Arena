-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419180947 "phase25d_pnm_materialized_view_and_cleanup"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a5fc428a632e5ee5ae72e9457af82ef2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 25 PART D — PNM materialized view + venue data quality cleanup
-- =========================================================================

-- ════════════════════════════════════════════════════════════════════════
-- 1) Hot-path materialized view: pre-computed "active poker locations" feed
--    Combines both sources. Used by /poker-near-me state index pages.
-- ════════════════════════════════════════════════════════════════════════
DROP MATERIALIZED VIEW IF EXISTS mv_active_poker_locations;

CREATE MATERIALIZED VIEW mv_active_poker_locations AS
SELECT 
    'venue'::text AS source,
    pv.id::text AS entity_id,
    pv.name::text AS name,
    pv.slug::text AS slug,
    COALESCE(pv.venue_type, 'poker_room')::text AS venue_type,
    pv.city::text AS city,
    pv.state::text AS state,
    pv.country::text AS country,
    COALESCE(pv.lat, pv.latitude)::numeric AS lat,
    COALESCE(pv.lng, pv.longitude)::numeric AS lng,
    ST_SetSRID(ST_MakePoint(COALESCE(pv.lng, pv.longitude), COALESCE(pv.lat, pv.latitude)), 4326)::geography AS location_geog,
    COALESCE(pv.profile_photo_url, pv.cover_photo_url, pv.logo_url)::text AS photo_url,
    pv.tagline::text AS tagline,
    pv.trust_score::numeric AS activity_score,
    COALESCE(pv.has_tournaments, false) AS has_tournaments,
    COALESCE(pv.is_claimed, false) AS is_verified,
    pv.poker_tables::integer AS poker_tables,
    array_to_string(pv.stakes_cash, ', ')::text AS stakes_cash,
    array_to_string(pv.games_offered, ', ')::text AS games_offered,
    NULL::integer AS member_count,
    NULL::integer AS games_hosted,
    NULL::boolean AS is_private,
    NOW() AS refreshed_at
  FROM poker_venues pv
 WHERE COALESCE(pv.is_active, true) = true
   AND COALESCE(pv.is_suppressed, false) = false
   AND COALESCE(pv.lat, pv.latitude) IS NOT NULL
   AND COALESCE(pv.lng, pv.longitude) IS NOT NULL
   AND pv.name IS NOT NULL
   AND pv.state IS NOT NULL

UNION ALL

SELECT 
    'home_group'::text,
    grp.id::text,
    grp.name::text,
    sp.slug::text,
    'home_game'::text,
    grp.city::text,
    grp.state::text,
    'US'::text,
    grp.latitude::numeric,
    grp.longitude::numeric,
    grp.location_geog,
    grp.profile_photo_url::text,
    grp.tagline::text,
    -- activity_score: composite of games_hosted, member_count, recency
    (COALESCE(grp.games_hosted, 0) * 2.0 
     + COALESCE(grp.member_count, 0) * 0.5
     + GREATEST(0, 30 - EXTRACT(day FROM (NOW() - grp.last_activity_at))::numeric))::numeric,
    EXISTS (SELECT 1 FROM commander_home_games g 
             WHERE g.group_id = grp.id AND g.format='tournament' 
               AND g.scheduled_date >= CURRENT_DATE
               AND g.status IN ('scheduled','confirmed')) AS has_tournaments,
    (grp.profile_photo_url IS NOT NULL AND grp.last_activity_at > NOW() - INTERVAL '30 days')
       AS is_verified,
    NULL::integer AS poker_tables,
    grp.default_stakes::text,
    grp.default_game_type::text,
    grp.member_count::integer,
    grp.games_hosted::integer,
    grp.is_private,
    NOW()
  FROM commander_home_groups grp
  LEFT JOIN social_pages sp ON sp.linked_entity_type='home_group' AND sp.linked_entity_id = grp.id::text
 WHERE grp.is_active = true
   AND NOT grp.is_private
   AND grp.profile_photo_url IS NOT NULL
   AND grp.last_activity_at > NOW() - INTERVAL '45 days'
   AND grp.location_geog IS NOT NULL;

-- Indexes for fast slicing
CREATE UNIQUE INDEX mv_active_poker_locations_pk 
    ON mv_active_poker_locations (source, entity_id);
CREATE INDEX mv_active_poker_locations_state 
    ON mv_active_poker_locations (state, source) 
    WHERE state IS NOT NULL;
CREATE INDEX mv_active_poker_locations_city 
    ON mv_active_poker_locations (city, state) 
    WHERE city IS NOT NULL;
CREATE INDEX mv_active_poker_locations_geog 
    ON mv_active_poker_locations USING GIST (location_geog);
CREATE INDEX mv_active_poker_locations_activity 
    ON mv_active_poker_locations (activity_score DESC NULLS LAST);

-- Refresh function (idempotent, non-blocking thanks to CONCURRENTLY)
CREATE OR REPLACE FUNCTION public.fn_refresh_active_poker_locations()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_count bigint; v_duration interval; v_started timestamptz;
BEGIN
    v_started := clock_timestamp();
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_active_poker_locations;
    v_duration := clock_timestamp() - v_started;
    SELECT COUNT(*) INTO v_count FROM mv_active_poker_locations;
    RETURN jsonb_build_object(
        'success', true, 
        'row_count', v_count,
        'duration_ms', EXTRACT(milliseconds FROM v_duration)
    );
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.fn_refresh_active_poker_locations() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_refresh_active_poker_locations() TO service_role;

-- Schedule refresh: every 30 min
SELECT cron.schedule(
    'pnm-locations-refresh',
    '*/30 * * * *',
    $$SELECT public.fn_refresh_active_poker_locations();$$
);

-- RPC for state index pages (e.g. /poker-near-me/nevada)
CREATE OR REPLACE FUNCTION public.get_poker_locations_by_state(
    p_state text,
    p_limit int DEFAULT 100
) RETURNS TABLE (
    source text, entity_id text, name text, slug text, venue_type text,
    city text, lat numeric, lng numeric,
    photo_url text, tagline text, activity_score numeric,
    has_tournaments boolean, is_verified boolean,
    poker_tables integer, stakes_cash text, games_offered text,
    member_count integer, games_hosted integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
    SELECT 
        source, entity_id, name, slug, venue_type,
        city, lat, lng,
        photo_url, tagline, activity_score,
        has_tournaments, is_verified,
        poker_tables, stakes_cash, games_offered,
        member_count, games_hosted
    FROM mv_active_poker_locations
    WHERE state = p_state
    ORDER BY activity_score DESC NULLS LAST, name
    LIMIT GREATEST(1, LEAST(p_limit, 500));
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_poker_locations_by_state(text, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_poker_locations_by_state(text, int) TO anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- 2) Venue data quality cleanup (scraper garbage)
--    Flag obvious non-tournament names like '@context', javascript snippets
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_flag_garbage_tournaments()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_flagged int;
BEGIN
    UPDATE venue_daily_tournaments
       SET is_suppressed = true, 
           updated_at = NOW()
     WHERE COALESCE(is_suppressed, false) = false
       AND (
          tournament_name IS NULL
          OR length(trim(tournament_name)) < 3
          OR tournament_name ~ '^[@;<>{}]'           -- starts with junk
          OR tournament_name ILIKE '%var %widget%'   -- inline JS
          OR tournament_name ILIKE '%@context%'      -- JSON-LD leak
          OR tournament_name ILIKE '%<script%'       -- HTML leak
          OR tournament_name ILIKE '%&nbsp;%'        -- entity garbage
          OR tournament_name ~ '^(\{|\[)'            -- raw JSON
       );
    GET DIAGNOSTICS v_flagged = ROW_COUNT;
    RETURN jsonb_build_object('success', true, 'suppressed_rows', v_flagged, 'run_at', NOW());
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.fn_flag_garbage_tournaments() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_flag_garbage_tournaments() TO service_role;

-- Run once immediately + schedule nightly
SELECT public.fn_flag_garbage_tournaments();

SELECT cron.schedule(
    'flag-garbage-tournaments',
    '15 3 * * *',  -- 03:15 UTC daily, after scraping typically completes
    $$SELECT public.fn_flag_garbage_tournaments();$$
);
