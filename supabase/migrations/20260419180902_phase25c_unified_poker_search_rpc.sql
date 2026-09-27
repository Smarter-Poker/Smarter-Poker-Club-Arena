-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419180902 "phase25c_unified_poker_search_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 078094bd5b842700c6391fbb5e2f9aa5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 25 PART C — Unified poker search (venues + home groups)
--  Full-text search + trigram fuzzy match across both entity types.
-- =========================================================================

-- Add FTS + trigram infrastructure to poker_venues if not already present
-- (commander_home_groups already has these from Phase 24/H)

-- 1) tsvector column for venues
ALTER TABLE poker_venues 
    ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Populate it for existing rows (A=name, B=city/tagline, C=state/venue_type, D=about)
UPDATE poker_venues SET search_vector = 
    setweight(to_tsvector('english', COALESCE(name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(city, '') || ' ' || COALESCE(tagline, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(state, '') || ' ' || COALESCE(venue_type, '')), 'C') ||
    setweight(to_tsvector('english', COALESCE(about, '')), 'D')
WHERE search_vector IS NULL;

-- Trigger to keep search_vector fresh
CREATE OR REPLACE FUNCTION public.fn_update_poker_venue_search_vector()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    NEW.search_vector := 
        setweight(to_tsvector('english', COALESCE(NEW.name, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.city, '') || ' ' || COALESCE(NEW.tagline, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.state, '') || ' ' || COALESCE(NEW.venue_type, '')), 'C') ||
        setweight(to_tsvector('english', COALESCE(NEW.about, '')), 'D');
    RETURN NEW;
END; $fn$;

DROP TRIGGER IF EXISTS trg_update_poker_venue_search_vector ON poker_venues;
CREATE TRIGGER trg_update_poker_venue_search_vector
    BEFORE INSERT OR UPDATE OF name, city, state, tagline, venue_type, about ON poker_venues
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_poker_venue_search_vector();

-- 2) Indexes
CREATE INDEX IF NOT EXISTS idx_poker_venues_search_gin 
    ON poker_venues USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_poker_venues_name_trgm 
    ON poker_venues USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_poker_venues_active_state 
    ON poker_venues (state, is_active) WHERE NOT COALESCE(is_suppressed, false);

-- 3) Unified search RPC
CREATE OR REPLACE FUNCTION public.search_poker_unified(
    p_query              text,
    p_state_filter       text DEFAULT NULL,
    p_city_filter        text DEFAULT NULL,
    p_include_venues     boolean DEFAULT true,
    p_include_home_games boolean DEFAULT true,
    p_inactivity_days    int DEFAULT 45,
    p_limit              int DEFAULT 30
) RETURNS TABLE (
    source text, entity_id text, name text, slug text, venue_type text,
    city text, state text,
    photo_url text, tagline text,
    rank_score numeric,
    -- Venue extras
    trust_score numeric, has_tournaments boolean,
    -- Home-game extras
    member_count integer, games_hosted integer, is_private boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_tsquery tsquery; v_has_query boolean;
BEGIN
    v_has_query := p_query IS NOT NULL AND length(trim(p_query)) > 0;
    IF v_has_query THEN
        -- Build a prefix-enabled tsquery; fall back to plain on failure
        BEGIN
            v_tsquery := to_tsquery('english', 
                regexp_replace(trim(p_query), '\s+', ' & ', 'g') || ':*'
            );
        EXCEPTION WHEN OTHERS THEN
            v_tsquery := plainto_tsquery('english', p_query);
        END;
    END IF;

    RETURN QUERY
    SELECT * FROM (
      -- Branch 1: poker venues
      SELECT 'venue'::text AS src, pv.id::text AS eid, pv.name::text AS nm, pv.slug::text AS sg,
             COALESCE(pv.venue_type, 'poker_room')::text AS vt,
             pv.city::text AS cy, pv.state::text AS st,
             COALESCE(pv.profile_photo_url, pv.cover_photo_url, pv.logo_url)::text AS ph,
             pv.tagline::text AS tg,
             CASE 
                 WHEN v_has_query THEN
                    (COALESCE(ts_rank(pv.search_vector, v_tsquery), 0) * 100.0
                     + similarity(pv.name, p_query) * 50.0)::numeric
                 ELSE COALESCE(pv.trust_score, 0)::numeric
             END AS rs,
             pv.trust_score::numeric AS ts,
             COALESCE(pv.has_tournaments, false) AS ht,
             NULL::integer AS mc, NULL::integer AS gh, NULL::boolean AS ipv
        FROM poker_venues pv
       WHERE p_include_venues = true
         AND COALESCE(pv.is_active, true) = true
         AND COALESCE(pv.is_suppressed, false) = false
         AND (p_state_filter IS NULL OR pv.state = p_state_filter)
         AND (p_city_filter IS NULL OR pv.city ILIKE p_city_filter)
         AND (
             NOT v_has_query
             OR pv.search_vector @@ v_tsquery
             OR pv.name ILIKE '%' || p_query || '%'
             OR similarity(pv.name, p_query) > 0.2
         )
      UNION ALL
      -- Branch 2: home groups
      SELECT 'home_group'::text, grp.id::text, grp.name::text, sp.slug::text, 'home_game'::text,
             grp.city::text, grp.state::text,
             grp.profile_photo_url::text, grp.tagline::text,
             CASE 
                 WHEN v_has_query THEN
                    (COALESCE(ts_rank(grp.search_vector, v_tsquery), 0) * 100.0
                     + similarity(grp.name, p_query) * 50.0)::numeric
                 ELSE COALESCE(grp.games_hosted, 0)::numeric
             END,
             NULL::numeric,
             EXISTS (SELECT 1 FROM commander_home_games g 
                      WHERE g.group_id = grp.id AND g.format='tournament' 
                        AND g.scheduled_date >= CURRENT_DATE
                        AND g.status IN ('scheduled','confirmed')),
             grp.member_count::integer, grp.games_hosted::integer, grp.is_private
        FROM commander_home_groups grp
        LEFT JOIN social_pages sp ON sp.linked_entity_type='home_group' AND sp.linked_entity_id = grp.id::text
       WHERE p_include_home_games = true
         AND grp.is_active = true
         AND NOT grp.is_private
         AND grp.profile_photo_url IS NOT NULL
         AND grp.last_activity_at > NOW() - (p_inactivity_days || ' days')::interval
         AND (p_state_filter IS NULL OR grp.state = p_state_filter)
         AND (p_city_filter IS NULL OR grp.city ILIKE p_city_filter)
         AND (
             NOT v_has_query
             OR grp.search_vector @@ v_tsquery
             OR grp.name ILIKE '%' || p_query || '%'
             OR similarity(grp.name, p_query) > 0.2
         )
    ) merged
    ORDER BY merged.rs DESC NULLS LAST
    LIMIT GREATEST(1, LEAST(p_limit, 200));
END;
$fn$;

COMMENT ON FUNCTION public.search_poker_unified(text, text, text, boolean, boolean, int, int) IS
  'Phase 25/C: Unified search across poker_venues + public commander_home_groups using FTS + trigram fuzzy match. Weighted relevance scoring.';

REVOKE EXECUTE ON FUNCTION public.search_poker_unified(text, text, text, boolean, boolean, int, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.search_poker_unified(text, text, text, boolean, boolean, int, int) TO anon, authenticated, service_role;
