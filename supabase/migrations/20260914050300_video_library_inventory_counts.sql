-- One statement sees the same inventory for the total and every source.
-- Returning aggregates avoids PostgREST's row cap on the underlying library.
CREATE OR REPLACE FUNCTION public.fn_video_library_scrape_inventory()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  WITH source_counts AS (
    SELECT nullif(source_id, '') AS source_id, count(*) AS videos
    FROM public.video_library_videos
    GROUP BY nullif(source_id, '')
  )
  SELECT jsonb_build_object(
    'total_videos', coalesce(sum(videos), 0)::bigint,
    'unassigned_videos', coalesce(sum(videos) FILTER (WHERE source_id IS NULL), 0)::bigint,
    'creators', count(*) FILTER (WHERE source_id IS NOT NULL),
    'by_source', coalesce(
      jsonb_object_agg(source_id, videos) FILTER (WHERE source_id IS NOT NULL),
      '{}'::jsonb
    )
  )
  FROM source_counts;
$function$;

REVOKE ALL ON FUNCTION public.fn_video_library_scrape_inventory() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_video_library_scrape_inventory() TO service_role;
COMMENT ON FUNCTION public.fn_video_library_scrape_inventory() IS
  'Read-only complete video inventory, aggregated in one snapshot; only the service may call it.';
