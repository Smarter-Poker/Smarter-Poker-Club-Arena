-- Read-only helper for the Club Arena phantom-ref CI gate (Phase U4). Returns
-- every public table/view + function name so scripts/ci/gen-schema-manifest.mjs
-- can refresh the committed manifest without direct SQL access. SECURITY DEFINER
-- so an anon/service call can read the catalogs; returns names only (no data).
-- Applied to prod via Supabase MCP 2026-07-29.
CREATE OR REPLACE FUNCTION public.fn_schema_manifest()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'tables', (SELECT coalesce(jsonb_agg(table_name ORDER BY table_name), '[]'::jsonb)
               FROM information_schema.tables
               WHERE table_schema='public' AND table_type IN ('BASE TABLE','VIEW')),
    'functions', (SELECT coalesce(jsonb_agg(DISTINCT proname ORDER BY proname), '[]'::jsonb)
                  FROM pg_proc WHERE pronamespace='public'::regnamespace)
  );
$function$;

GRANT EXECUTE ON FUNCTION public.fn_schema_manifest() TO anon, authenticated, service_role;
