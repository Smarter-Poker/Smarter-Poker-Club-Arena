-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419193239 "phase28a_fix_sitemap_timestamp_column"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 31b1ae15bb115ace5a8eb79773d33b38 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: poker_venues has last_scraped_at, not updated_at
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
                'name', name, 'last_modified', last_scraped_at,
                'url_path', '/poker-near-me/' || 
                            lower(COALESCE(state, 'us')) || '/' ||
                            COALESCE(regexp_replace(lower(city), '[^a-z0-9]+', '-', 'g'), 'city') || '/' ||
                            slug
            ) ORDER BY last_scraped_at DESC NULLS LAST, id)
              FROM (SELECT id, slug, state, city, name, last_scraped_at
                      FROM poker_venues 
                     WHERE slug IS NOT NULL 
                       AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false)
                     ORDER BY last_scraped_at DESC NULLS LAST, id
                     LIMIT p_limit OFFSET p_offset) t
        ), '[]'::jsonb)
    ) INTO v_result;
    RETURN v_result;
END; $fn$;

-- Same fix for pnm_index_sitemap_entries
CREATE OR REPLACE FUNCTION public.get_pnm_index_sitemap_entries()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_result jsonb;
BEGIN
    WITH state_entries AS (
        SELECT DISTINCT state, COUNT(*) AS venue_count, MAX(last_scraped_at) AS last_updated
          FROM poker_venues 
         WHERE state IS NOT NULL AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false)
         GROUP BY state
    ),
    city_entries AS (
        SELECT DISTINCT state, city, COUNT(*) AS venue_count, MAX(last_scraped_at) AS last_updated
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
