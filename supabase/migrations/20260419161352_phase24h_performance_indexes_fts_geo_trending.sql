-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419161352 "phase24h_performance_indexes_fts_geo_trending"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8dda25c4e242c45f70a223baccbfbe1a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 24 PART H — Performance: FTS, spatial, trending
--  -----------------------------------------------------------------------
--  P7.1 tsvector FTS on commander_home_groups
--  P7.2 PostGIS GIST spatial index on lat/lng
--  P7.3 Materialized view for trending groups by RSVP velocity
--       + pg_cron refresh every 15 min
-- =========================================================================

-- ════════════════════════════════════════════════════════════════════════
-- P7.1 — Full-text search tsvector
-- ════════════════════════════════════════════════════════════════════════
ALTER TABLE commander_home_groups 
    ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION public.fn_home_group_refresh_search_vector()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
    NEW.search_vector := 
          setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A')
       || setweight(to_tsvector('english', coalesce(NEW.tagline, '')), 'B')
       || setweight(to_tsvector('english', coalesce(NEW.city, '')), 'B')
       || setweight(to_tsvector('english', coalesce(NEW.state, '')), 'C')
       || setweight(to_tsvector('english', coalesce(NEW.description, '')), 'D')
       || setweight(to_tsvector('english', coalesce(array_to_string(NEW.tags, ' '), '')), 'B');
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_home_group_search_vector
    BEFORE INSERT OR UPDATE OF name, tagline, description, city, state, tags 
    ON commander_home_groups
    FOR EACH ROW EXECUTE FUNCTION public.fn_home_group_refresh_search_vector();

-- GIN index for FTS queries
CREATE INDEX IF NOT EXISTS idx_home_groups_search_vector 
    ON commander_home_groups USING GIN (search_vector);

-- GIN trigram index for fuzzy "typo-tolerant" matches on name
CREATE INDEX IF NOT EXISTS idx_home_groups_name_trgm 
    ON commander_home_groups USING GIN (name gin_trgm_ops);

-- Backfill existing rows
UPDATE commander_home_groups 
   SET search_vector = 
          setweight(to_tsvector('english', coalesce(name, '')), 'A')
       || setweight(to_tsvector('english', coalesce(tagline, '')), 'B')
       || setweight(to_tsvector('english', coalesce(city, '')), 'B')
       || setweight(to_tsvector('english', coalesce(state, '')), 'C')
       || setweight(to_tsvector('english', coalesce(description, '')), 'D')
       || setweight(to_tsvector('english', coalesce(array_to_string(tags, ' '), '')), 'B')
 WHERE search_vector IS NULL;

-- ════════════════════════════════════════════════════════════════════════
-- P7.2 — PostGIS geography column for fast spatial queries
-- ════════════════════════════════════════════════════════════════════════
ALTER TABLE commander_home_groups
    ADD COLUMN IF NOT EXISTS location_geog geography(Point, 4326);

CREATE OR REPLACE FUNCTION public.fn_home_group_refresh_geog()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $fn$
BEGIN
    IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
        NEW.location_geog := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
    ELSE
        NEW.location_geog := NULL;
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_home_group_location_geog
    BEFORE INSERT OR UPDATE OF latitude, longitude ON commander_home_groups
    FOR EACH ROW EXECUTE FUNCTION public.fn_home_group_refresh_geog();

-- GIST spatial index
CREATE INDEX IF NOT EXISTS idx_home_groups_location_geog 
    ON commander_home_groups USING GIST (location_geog);

-- Backfill
UPDATE commander_home_groups 
   SET location_geog = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
 WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND location_geog IS NULL;

-- ════════════════════════════════════════════════════════════════════════
-- P7.3 — Trending materialized view (refreshed every 15 min)
-- Scores groups by recent RSVP velocity + view_count + member_count
-- ════════════════════════════════════════════════════════════════════════
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_home_groups_trending AS
SELECT 
    g.id AS group_id,
    g.name,
    g.city,
    g.state,
    g.is_private,
    g.profile_photo_url,
    g.tags,
    g.location_geog,
    COALESCE(g.member_count, 0) AS member_count,
    COALESCE(g.games_hosted, 0) AS games_hosted,
    COALESCE(g.view_count, 0) AS view_count,
    COALESCE(g.share_click_count, 0) AS share_click_count,
    -- Recent RSVP velocity: count of YES rsvps in last 30 days
    COALESCE((
        SELECT COUNT(*) FROM commander_home_rsvps r
        JOIN commander_home_games hg ON hg.id = r.game_id
        WHERE hg.group_id = g.id 
          AND r.response = 'yes'
          AND r.responded_at > NOW() - INTERVAL '30 days'
    ), 0) AS recent_rsvps_30d,
    -- Trending score: weighted combo
    (
        COALESCE((SELECT COUNT(*) FROM commander_home_rsvps r
                   JOIN commander_home_games hg ON hg.id = r.game_id
                   WHERE hg.group_id = g.id AND r.response='yes'
                     AND r.responded_at > NOW() - INTERVAL '30 days'), 0) * 10
      + COALESCE(g.view_count, 0) * 0.1
      + COALESCE(g.share_click_count, 0) * 2
      + COALESCE(g.member_count, 0) * 0.5
      + CASE WHEN NOT g.is_private THEN 5 ELSE 0 END
    )::numeric AS trending_score,
    g.last_activity_at
  FROM commander_home_groups g
 WHERE g.is_active = true
   AND g.profile_photo_url IS NOT NULL
   AND g.last_activity_at > NOW() - INTERVAL '45 days'
 ORDER BY trending_score DESC;

CREATE UNIQUE INDEX IF NOT EXISTS mv_home_groups_trending_pk ON mv_home_groups_trending(group_id);
CREATE INDEX IF NOT EXISTS idx_mv_home_trending_score ON mv_home_groups_trending(trending_score DESC);
CREATE INDEX IF NOT EXISTS idx_mv_home_trending_geog ON mv_home_groups_trending USING GIST (location_geog);

-- Refresh function (CONCURRENTLY is safe because we have a unique index)
CREATE OR REPLACE FUNCTION public.fn_refresh_trending_home_groups()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_home_groups_trending;
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.fn_refresh_trending_home_groups() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_refresh_trending_home_groups() TO service_role;

-- Schedule refresh every 15 minutes
SELECT cron.schedule(
    'home-trending-refresh',
    '*/15 * * * *',
    $$SELECT public.fn_refresh_trending_home_groups();$$
);

-- Public accessor: get top N trending groups (optionally geo-filtered)
CREATE OR REPLACE FUNCTION public.get_trending_home_groups(
    p_limit          int DEFAULT 12,
    p_near_lat       numeric DEFAULT NULL,
    p_near_lng       numeric DEFAULT NULL,
    p_radius_miles   int DEFAULT NULL
) RETURNS TABLE (
    group_id uuid, name text, city text, state text,
    profile_photo_url text, is_private boolean,
    member_count int, recent_rsvps_30d bigint,
    trending_score numeric, distance_miles numeric,
    tags text[]
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_point geography;
BEGIN
    IF p_near_lat IS NOT NULL AND p_near_lng IS NOT NULL THEN
        v_point := ST_SetSRID(ST_MakePoint(p_near_lng, p_near_lat), 4326)::geography;
    END IF;

    RETURN QUERY
    SELECT 
        mv.group_id, mv.name, mv.city, mv.state, mv.profile_photo_url, 
        mv.is_private, mv.member_count, mv.recent_rsvps_30d, mv.trending_score,
        CASE WHEN v_point IS NOT NULL AND mv.location_geog IS NOT NULL
             THEN ROUND((ST_Distance(mv.location_geog, v_point) / 1609.344)::numeric, 1)
             ELSE NULL END AS distance_miles,
        mv.tags
      FROM mv_home_groups_trending mv
     WHERE (v_point IS NULL OR p_radius_miles IS NULL OR mv.location_geog IS NULL
            OR ST_DWithin(mv.location_geog, v_point, p_radius_miles * 1609.344))
     ORDER BY mv.trending_score DESC
     LIMIT GREATEST(1, LEAST(p_limit, 50));
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.get_trending_home_groups(int, numeric, numeric, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_trending_home_groups(int, numeric, numeric, int) TO anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- BONUS: Upgrade search_home_groups to use FTS + GIST when available
-- (Drop and recreate with the faster pathway)
-- ════════════════════════════════════════════════════════════════════════
-- Note: the existing search_home_groups RPC (Phase 23) uses ILIKE + haversine.
-- Instead of rewriting it here (could break consumers), we publish a new v2 RPC.
-- Frontend can migrate to the v2 at leisure.

CREATE OR REPLACE FUNCTION public.search_home_groups_v2(
    p_search_text     text DEFAULT NULL,
    p_city            text DEFAULT NULL,
    p_state           text DEFAULT NULL,
    p_game_type       text DEFAULT NULL,
    p_stakes          text DEFAULT NULL,
    p_tags            text[] DEFAULT NULL,
    p_lat             numeric DEFAULT NULL,
    p_lng             numeric DEFAULT NULL,
    p_radius_miles    int DEFAULT NULL,
    p_exclude_joined  boolean DEFAULT false,
    p_viewer_user_id  uuid DEFAULT NULL,
    p_limit           int DEFAULT 50,
    p_inactivity_days int DEFAULT 45
) RETURNS TABLE (
    group_id uuid, name text, slug text, tagline text, description text,
    city text, state text, profile_photo_url text, cover_photo_url text,
    is_private boolean, member_count int, games_hosted int,
    distance_miles numeric, tags text[],
    relevance_score real, recent_rsvps_30d bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_point  geography;
    v_tsquery tsquery;
BEGIN
    IF p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
        v_point := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
    END IF;

    IF p_search_text IS NOT NULL AND length(trim(p_search_text)) > 0 THEN
        v_tsquery := plainto_tsquery('english', p_search_text);
    END IF;

    RETURN QUERY
    SELECT 
        g.id, g.name,
        sp.slug,
        g.tagline, g.description,
        g.city, g.state, g.profile_photo_url, g.cover_photo_url,
        g.is_private,
        COALESCE(g.member_count, 0),
        COALESCE(g.games_hosted, 0),
        CASE WHEN v_point IS NOT NULL AND g.location_geog IS NOT NULL
             THEN ROUND((ST_Distance(g.location_geog, v_point) / 1609.344)::numeric, 1)
             ELSE NULL END,
        g.tags,
        CASE WHEN v_tsquery IS NOT NULL 
             THEN ts_rank(g.search_vector, v_tsquery)
             ELSE 0::real END,
        COALESCE((
            SELECT COUNT(*) FROM commander_home_rsvps r
            JOIN commander_home_games hg ON hg.id = r.game_id
            WHERE hg.group_id = g.id AND r.response='yes'
              AND r.responded_at > NOW() - INTERVAL '30 days'
        ), 0)
      FROM commander_home_groups g
      LEFT JOIN social_pages sp ON sp.linked_entity_type='home_group' AND sp.linked_entity_id = g.id::text
     WHERE g.is_active = true
       AND NOT g.is_private                 -- public-only discovery
       AND g.profile_photo_url IS NOT NULL  -- Phase 17 logo requirement
       AND g.last_activity_at > NOW() - (p_inactivity_days || ' days')::interval
       AND (v_tsquery IS NULL OR g.search_vector @@ v_tsquery)
       AND (p_city  IS NULL OR g.city  ILIKE '%' || p_city  || '%')
       AND (p_state IS NULL OR g.state ILIKE '%' || p_state || '%')
       AND (p_game_type IS NULL OR g.default_game_type = p_game_type)
       AND (p_stakes    IS NULL OR g.default_stakes    = p_stakes)
       AND (p_tags IS NULL OR g.tags && p_tags)
       AND (v_point IS NULL OR p_radius_miles IS NULL OR g.location_geog IS NULL
            OR ST_DWithin(g.location_geog, v_point, p_radius_miles * 1609.344))
       AND (NOT p_exclude_joined OR p_viewer_user_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM commander_home_members m 
               WHERE m.group_id = g.id AND m.user_id = p_viewer_user_id 
                 AND m.status IN ('approved','pending')))
     ORDER BY 
        CASE WHEN v_tsquery IS NOT NULL THEN ts_rank(g.search_vector, v_tsquery) ELSE 0::real END DESC,
        CASE WHEN v_point IS NOT NULL AND g.location_geog IS NOT NULL 
             THEN ST_Distance(g.location_geog, v_point) 
             ELSE 999999999 END ASC,
        g.last_activity_at DESC
     LIMIT GREATEST(1, LEAST(p_limit, 100));
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.search_home_groups_v2(text,text,text,text,text,text[],numeric,numeric,int,boolean,uuid,int,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_home_groups_v2(text,text,text,text,text,text[],numeric,numeric,int,boolean,uuid,int,int) TO anon, authenticated, service_role;

-- Initial populate of the MV so /trending has data from day 1
SELECT public.fn_refresh_trending_home_groups();
