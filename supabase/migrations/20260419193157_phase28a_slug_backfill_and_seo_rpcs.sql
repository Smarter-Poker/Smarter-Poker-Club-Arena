-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419193157 "phase28a_slug_backfill_and_seo_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 326cb4a62717ca6afe784bd3b1d51a6d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
-- PHASE 28 PART A — Slug backfill + SEO RPCs for Poker Near Me
-- Zero money. Pure content/discovery/SEO infrastructure.
-- ══════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────
-- 1) Slug generator helper
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_generate_venue_slug(
    p_name text,
    p_city text DEFAULT NULL,
    p_state text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $fn$
DECLARE v_base text;
BEGIN
    -- Lowercase, strip non-alphanum (except space + hyphen), collapse whitespace/hyphens
    v_base := lower(COALESCE(p_name, ''));
    v_base := regexp_replace(v_base, '[''\u2019\u2018`]', '', 'g');                 -- apostrophes
    v_base := regexp_replace(v_base, '&', ' and ', 'g');                            -- ampersands
    v_base := regexp_replace(v_base, '[^a-z0-9]+', '-', 'g');                       -- anything else → hyphen
    v_base := regexp_replace(v_base, '^-+|-+$', '', 'g');                           -- trim leading/trailing hyphens
    v_base := regexp_replace(v_base, '-{2,}', '-', 'g');                            -- collapse multiple hyphens
    IF length(v_base) < 3 AND p_city IS NOT NULL THEN
        v_base := v_base || '-' || lower(regexp_replace(p_city, '[^a-z0-9]+', '-', 'g'));
        v_base := regexp_replace(v_base, '^-+|-+$', '', 'g');
    END IF;
    IF length(v_base) = 0 THEN v_base := 'poker-venue'; END IF;
    RETURN v_base;
END;
$fn$;

-- ────────────────────────────────────────────────────────────────────────
-- 2) Backfill slugs for venues that don't have one (collision-safe)
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_backfill_venue_slugs()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_venue RECORD; v_base text; v_candidate text; v_n int; v_updated int := 0;
    v_reused int := 0;
BEGIN
    FOR v_venue IN 
        SELECT id, name, city, state FROM poker_venues
         WHERE slug IS NULL 
           AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false)
         ORDER BY id
    LOOP
        v_base := public.fn_generate_venue_slug(v_venue.name, v_venue.city, v_venue.state);
        v_candidate := v_base;
        v_n := 0;
        -- Collision resolve: try name, then name-city, then name-2, name-3, etc.
        WHILE EXISTS(SELECT 1 FROM poker_venues WHERE slug = v_candidate AND id <> v_venue.id) LOOP
            v_n := v_n + 1;
            IF v_n = 1 AND v_venue.city IS NOT NULL THEN
                v_candidate := v_base || '-' || lower(regexp_replace(v_venue.city, '[^a-z0-9]+', '-', 'g'));
                v_candidate := regexp_replace(v_candidate, '-{2,}', '-', 'g');
            ELSIF v_n = 2 AND v_venue.state IS NOT NULL THEN
                v_candidate := v_base || '-' || lower(v_venue.state);
            ELSE
                v_candidate := v_base || '-' || v_n::text;
            END IF;
            v_reused := v_reused + 1;
        END LOOP;
        UPDATE poker_venues SET slug = v_candidate WHERE id = v_venue.id;
        v_updated := v_updated + 1;
    END LOOP;
    RETURN jsonb_build_object('success', true, 'updated', v_updated, 'collision_resolutions', v_reused);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.fn_backfill_venue_slugs() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_backfill_venue_slugs() TO service_role;

-- Run the backfill now
SELECT public.fn_backfill_venue_slugs();

-- Ensure slug uniqueness going forward
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes 
                    WHERE schemaname='public' AND indexname='uniq_poker_venues_slug') THEN
        CREATE UNIQUE INDEX uniq_poker_venues_slug 
            ON poker_venues (slug) WHERE slug IS NOT NULL;
    END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────
-- 3) Sitemap data RPC — cursor-paginated, public
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_venue_sitemap_data(
    p_limit  int DEFAULT 1000,
    p_offset int DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_result jsonb; v_total int;
BEGIN
    p_limit := LEAST(GREATEST(p_limit, 1), 5000);
    p_offset := GREATEST(p_offset, 0);
    SELECT COUNT(*) INTO v_total FROM poker_venues 
     WHERE slug IS NOT NULL AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false);

    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'total', v_total,
        'offset', p_offset, 'limit', p_limit,
        'has_more', p_offset + p_limit < v_total,
        'venues', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'slug', slug, 'state', state, 'city', city,
                'name', name, 'updated_at', updated_at,
                'url_path', '/poker-near-me/' || 
                            lower(COALESCE(state, 'us')) || '/' ||
                            COALESCE(regexp_replace(lower(city), '[^a-z0-9]+', '-', 'g'), 'city') || '/' ||
                            slug
            ) ORDER BY updated_at DESC NULLS LAST, id)
              FROM (SELECT id, slug, state, city, name, updated_at 
                      FROM poker_venues 
                     WHERE slug IS NOT NULL 
                       AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false)
                     ORDER BY updated_at DESC NULLS LAST, id
                     LIMIT p_limit OFFSET p_offset) t
        ), '[]'::jsonb)
    ) INTO v_result;
    RETURN v_result;
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.get_venue_sitemap_data(int, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_venue_sitemap_data(int, int) TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- 4) Sitemap entries for state and city index pages
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_pnm_index_sitemap_entries()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_result jsonb;
BEGIN
    WITH state_entries AS (
        SELECT DISTINCT state, COUNT(*) AS venue_count, MAX(updated_at) AS last_updated
          FROM poker_venues 
         WHERE state IS NOT NULL AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false)
         GROUP BY state
    ),
    city_entries AS (
        SELECT DISTINCT state, city, COUNT(*) AS venue_count, MAX(updated_at) AS last_updated
          FROM poker_venues 
         WHERE state IS NOT NULL AND city IS NOT NULL 
           AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false)
         GROUP BY state, city
        HAVING COUNT(*) >= 1
    )
    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'state_count', (SELECT COUNT(*) FROM state_entries),
        'city_count', (SELECT COUNT(*) FROM city_entries),
        'state_entries', (SELECT jsonb_agg(jsonb_build_object(
            'state', state, 'venue_count', venue_count, 'last_updated', last_updated,
            'url_path', '/poker-near-me/' || lower(state)
          ) ORDER BY state) FROM state_entries),
        'city_entries', (SELECT jsonb_agg(jsonb_build_object(
            'state', state, 'city', city, 'venue_count', venue_count, 'last_updated', last_updated,
            'url_path', '/poker-near-me/' || lower(state) || '/' || 
                        regexp_replace(lower(city), '[^a-z0-9]+', '-', 'g')
          ) ORDER BY state, city) FROM city_entries)
    ) INTO v_result;
    RETURN v_result;
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.get_pnm_index_sitemap_entries() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_pnm_index_sitemap_entries() TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- 5) State index page SEO data — structured data for /poker-near-me/[state]
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_poker_near_me_state_seo(p_state text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_result jsonb; v_state_upper text;
BEGIN
    IF p_state IS NULL OR length(p_state) < 2 THEN RAISE EXCEPTION 'INVALID_STATE'; END IF;
    v_state_upper := upper(p_state);

    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'state', v_state_upper,
        'url_path', '/poker-near-me/' || lower(v_state_upper),
        'total_venues', (SELECT COUNT(*) FROM poker_venues 
                          WHERE state = v_state_upper 
                            AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false)),
        'tournaments_this_week', (
            SELECT COUNT(*) FROM venue_daily_tournaments t
              JOIN poker_venues v ON v.id = t.venue_id
             WHERE v.state = v_state_upper 
               AND COALESCE(v.is_active,true) AND NOT COALESCE(v.is_suppressed,false)
               AND COALESCE(t.is_active,true) AND NOT COALESCE(t.is_suppressed,false)
        ),
        'cities', (
            SELECT jsonb_agg(jsonb_build_object(
                'city', city, 'venue_count', venue_count,
                'url_path', '/poker-near-me/' || lower(v_state_upper) || '/' ||
                            regexp_replace(lower(city), '[^a-z0-9]+', '-', 'g')
              ) ORDER BY venue_count DESC, city)
              FROM (SELECT city, COUNT(*) AS venue_count
                      FROM poker_venues
                     WHERE state = v_state_upper AND city IS NOT NULL
                       AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false)
                     GROUP BY city ORDER BY venue_count DESC) t
        ),
        'top_venues', (
            SELECT jsonb_agg(jsonb_build_object(
                'id', id, 'name', name, 'slug', slug, 'city', city, 'venue_type', venue_type,
                'trust_score', trust_score, 'is_claimed', is_claimed,
                'poker_tables', poker_tables, 'tagline', tagline,
                'url_path', '/poker-near-me/' || lower(v_state_upper) || '/' ||
                            regexp_replace(lower(city), '[^a-z0-9]+', '-', 'g') || '/' || slug
              ) ORDER BY trust_score DESC NULLS LAST, is_claimed DESC, name)
              FROM (SELECT id, name, slug, city, venue_type, trust_score, is_claimed, poker_tables, tagline
                      FROM poker_venues
                     WHERE state = v_state_upper AND slug IS NOT NULL
                       AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false)
                     ORDER BY trust_score DESC NULLS LAST LIMIT 20) t
        ),
        'meta', jsonb_build_object(
            'title', 'Poker Rooms in ' || v_state_upper || ' | Smarter.Poker',
            'description', 'Find live poker rooms, tournaments, and cash games in ' || v_state_upper || '. Verified venues, real-time tournament schedules, player reviews.'
        )
    ) INTO v_result;
    RETURN v_result;
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.get_poker_near_me_state_seo(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_poker_near_me_state_seo(text) TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- 6) City index page SEO data — /poker-near-me/[state]/[city]
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_poker_near_me_city_seo(
    p_state text, p_city text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_result jsonb; v_state_upper text;
BEGIN
    IF p_state IS NULL OR p_city IS NULL THEN RAISE EXCEPTION 'STATE_AND_CITY_REQUIRED'; END IF;
    v_state_upper := upper(p_state);

    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'state', v_state_upper, 'city', p_city,
        'url_path', '/poker-near-me/' || lower(v_state_upper) || '/' || 
                    regexp_replace(lower(p_city), '[^a-z0-9]+', '-', 'g'),
        'total_venues', (SELECT COUNT(*) FROM poker_venues 
                          WHERE state = v_state_upper AND city ILIKE p_city
                            AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false)),
        'tournaments_this_week', (
            SELECT COUNT(*) FROM venue_daily_tournaments t
              JOIN poker_venues v ON v.id = t.venue_id
             WHERE v.state = v_state_upper AND v.city ILIKE p_city
               AND COALESCE(v.is_active,true) AND NOT COALESCE(v.is_suppressed,false)
               AND COALESCE(t.is_active,true) AND NOT COALESCE(t.is_suppressed,false)
        ),
        'venues', (
            SELECT jsonb_agg(jsonb_build_object(
                'id', id, 'name', name, 'slug', slug, 'venue_type', venue_type,
                'trust_score', trust_score, 'is_claimed', is_claimed,
                'poker_tables', poker_tables, 'tagline', tagline, 'about', about,
                'phone', phone, 'website', website, 'address', address,
                'stakes_cash', stakes_cash, 'games_offered', games_offered,
                'follower_count', follower_count,
                'url_path', '/poker-near-me/' || lower(v_state_upper) || '/' ||
                            regexp_replace(lower(p_city), '[^a-z0-9]+', '-', 'g') || '/' || slug
              ) ORDER BY trust_score DESC NULLS LAST, is_claimed DESC, name)
              FROM (SELECT id, name, slug, venue_type, trust_score, is_claimed, poker_tables,
                           tagline, about, phone, website, address, stakes_cash, games_offered, follower_count
                      FROM poker_venues
                     WHERE state = v_state_upper AND city ILIKE p_city AND slug IS NOT NULL
                       AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false)
                     ORDER BY trust_score DESC NULLS LAST) t
        ),
        'meta', jsonb_build_object(
            'title', 'Poker Rooms in ' || p_city || ', ' || v_state_upper || ' | Smarter.Poker',
            'description', 'Complete guide to poker rooms in ' || p_city || ', ' || v_state_upper || '. Live cash games, tournaments, verified reviews, and up-to-date schedules.'
        )
    ) INTO v_result;
    RETURN v_result;
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.get_poker_near_me_city_seo(text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_poker_near_me_city_seo(text, text) TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- 7) JSON-LD LocalBusiness schema generator for individual venue pages
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_venue_jsonld_schema(p_venue_slug text DEFAULT NULL, p_venue_id integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_venue RECORD; v_result jsonb; v_avg_rating numeric; v_review_count int;
BEGIN
    IF p_venue_slug IS NULL AND p_venue_id IS NULL THEN RAISE EXCEPTION 'SLUG_OR_ID_REQUIRED'; END IF;

    SELECT id, name, slug, tagline, about, city, state, country, address, phone, website,
           venue_type, latitude, longitude, is_claimed, hours
      INTO v_venue
      FROM poker_venues
     WHERE ((p_venue_id IS NOT NULL AND id = p_venue_id)
            OR (p_venue_slug IS NOT NULL AND slug = p_venue_slug))
       AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false)
     LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'VENUE_NOT_FOUND'; END IF;

    SELECT ROUND(AVG(overall_rating), 2), COUNT(*) 
      INTO v_avg_rating, v_review_count
      FROM commander_venue_reviews 
     WHERE venue_id = v_venue.id AND is_published = true;

    -- Schema.org LocalBusiness JSON-LD
    SELECT jsonb_build_object(
        '@context', 'https://schema.org',
        '@type', CASE v_venue.venue_type 
                    WHEN 'casino' THEN 'Casino'
                    WHEN 'cardroom' THEN 'EntertainmentBusiness'
                    WHEN 'poker_club' THEN 'EntertainmentBusiness'
                    ELSE 'LocalBusiness' END,
        'name', v_venue.name,
        'description', COALESCE(v_venue.tagline, v_venue.about),
        'url', 'https://smarter.poker/poker-near-me/' || 
               lower(COALESCE(v_venue.state, 'us')) || '/' ||
               COALESCE(regexp_replace(lower(v_venue.city), '[^a-z0-9]+', '-', 'g'), 'city') || '/' ||
               v_venue.slug,
        'telephone', v_venue.phone,
        'sameAs', CASE WHEN v_venue.website IS NOT NULL THEN jsonb_build_array(v_venue.website) ELSE '[]'::jsonb END,
        'address', CASE WHEN v_venue.address IS NOT NULL OR v_venue.city IS NOT NULL THEN
            jsonb_build_object(
                '@type', 'PostalAddress',
                'streetAddress', v_venue.address,
                'addressLocality', v_venue.city,
                'addressRegion', v_venue.state,
                'addressCountry', COALESCE(v_venue.country, 'US')
            ) ELSE NULL END,
        'geo', CASE WHEN v_venue.latitude IS NOT NULL AND v_venue.longitude IS NOT NULL THEN
            jsonb_build_object(
                '@type', 'GeoCoordinates',
                'latitude', v_venue.latitude, 'longitude', v_venue.longitude
            ) ELSE NULL END,
        'openingHours', v_venue.hours,
        'aggregateRating', CASE WHEN v_review_count > 0 THEN
            jsonb_build_object(
                '@type', 'AggregateRating',
                'ratingValue', v_avg_rating,
                'reviewCount', v_review_count,
                'bestRating', 5, 'worstRating', 1
            ) ELSE NULL END
    ) INTO v_result;
    RETURN v_result;
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.get_venue_jsonld_schema(text, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_venue_jsonld_schema(text, integer) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.fn_backfill_venue_slugs() IS
  'Phase 28/A: One-time backfill for venues missing slugs. Collision-safe.';
COMMENT ON FUNCTION public.get_poker_near_me_state_seo(text) IS
  'Phase 28/A: Structured data for /poker-near-me/[state] — total venues, cities, top 20 venues, tournament count.';
COMMENT ON FUNCTION public.get_poker_near_me_city_seo(text, text) IS
  'Phase 28/A: Full page data for /poker-near-me/[state]/[city] — all venues in city sorted by trust.';
COMMENT ON FUNCTION public.get_venue_jsonld_schema(text, integer) IS
  'Phase 28/A: Schema.org LocalBusiness JSON-LD for /poker-near-me/[state]/[city]/[slug] pages.';
