-- Read-only helper for the phantom-COLUMN CI gate: returns {table: [columns]}
-- for every public table/view so scripts/ci/gen-schema-manifest.mjs can refresh
-- scripts/ci/supabase-columns-manifest.json without direct SQL access.
-- Applied to prod via Supabase MCP 2026-07-29.
CREATE OR REPLACE FUNCTION public.fn_columns_manifest()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT coalesce(jsonb_object_agg(table_name, cols), '{}'::jsonb)
  FROM (
    SELECT table_name, jsonb_agg(column_name ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema='public'
    GROUP BY table_name
  ) t;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_columns_manifest() TO anon, authenticated, service_role;
