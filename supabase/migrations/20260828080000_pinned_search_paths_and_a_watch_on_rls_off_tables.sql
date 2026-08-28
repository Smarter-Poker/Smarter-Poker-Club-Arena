-- ═══════════════════════════════════════════════════════════════════════════
--  FOUR UNPINNED SEARCH PATHS, AND A STANDING WATCH ON THE ONE THING I
--  COULD NOT FIX
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Applied to production 2026-08-28 via the Supabase MCP (apply_migration
-- "pin_search_paths_and_watch_for_rls_disabled_writable_tables").
--
-- Supabase's database linter reported 793 findings. Exactly one was ERROR level
-- and four more were the kind that only get worse with time.
--
-- ─── 1. Four functions with a mutable search_path ──────────────────────────
--
-- fn_horse_hash(text), fn_horse_hash_fnv(text), fn_horse_lane(text) and
-- fn_place_entitlement(numeric, anyelement, integer) had none pinned.
--
-- All four are SECURITY INVOKER, so this is NOT the privilege-escalation shape
-- that makes an unpinned search_path dangerous in a DEFINER function - worth
-- saying plainly rather than dressing it up as a bigger fix than it is. It is
-- still wrong: a name resolved against the caller's search_path is a function
-- whose behaviour depends on who calls it, and fn_horse_lane decides which lane
-- a horse plays in.
--
-- Pinned with ALTER FUNCTION rather than by rewriting four correct bodies.
--
-- ─── 2. spatial_ref_sys: CONFIRMED EXPOSED, AND I COULD NOT CLOSE IT ───────
--
-- The single ERROR-level advisory. PostGIS's reference-system table, 8,500 rows
-- of SRID definitions, sits in `public` with RLS disabled while `anon` and
-- `authenticated` hold arwdDxtm - every write privilege.
--
-- Confirmed reachable, read-only, with the public anon key:
--
--   GET  /rest/v1/spatial_ref_sys?select=srid&limit=2 -> HTTP 200, real rows
--   OPTIONS /rest/v1/spatial_ref_sys                  -> allow: GET, HEAD, POST, OPTIONS
--
-- Not academic: find_live_games_nearby resolves coordinates through PostGIS, so
-- an anonymous caller corrupting or deleting SRID 4326 breaks venue search for
-- everybody.
--
-- I COULD NOT FIX IT, and this says so rather than pretending. The table is
-- owned by supabase_admin and the grants were made BY supabase_admin. `postgres`
-- holds the privileges but is not the grantor, so its REVOKE is a silent no-op -
-- the exact shape of the column-level REVOKE that read as a fix and did nothing
-- on 2026-08-27. Both routes were tried and both failed:
--
--   REVOKE ... FROM anon, authenticated  -> the assertion still found the writes,
--                                           so the migration refused to ship
--   SET LOCAL ROLE supabase_admin        -> 42501 permission denied
--
-- It needs an owner-level action through Supabase support or the dashboard.
-- Until then it must not be quietly forgotten, so the daily auditor gains a
-- third question and the finding becomes a standing, self-closing alarm rather
-- than a line in a report nobody re-reads. It is baselined with that reasoning
-- in scripts/ci/definer-exposure-baseline.json, so a NEW RLS-off writable table
-- still fails the audit loudly.

ALTER FUNCTION public.fn_horse_hash(text)         SET search_path TO 'public', 'pg_temp';
ALTER FUNCTION public.fn_horse_hash_fnv(text)     SET search_path TO 'public', 'pg_temp';
ALTER FUNCTION public.fn_horse_lane(text)         SET search_path TO 'public', 'pg_temp';
ALTER FUNCTION public.fn_place_entitlement(numeric, anyelement, integer)
                                                  SET search_path TO 'public', 'pg_temp';

CREATE OR REPLACE FUNCTION public.fn_definer_exposure_audit()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    -- 1. Reachable from a browser, writes, and cannot know who is calling.
    'unauthenticated_writers', COALESCE((
      SELECT jsonb_agg(e ORDER BY e->>'function')
        FROM (
          SELECT jsonb_build_object(
                   'function', p.proname,
                   'args', pg_get_function_identity_arguments(p.oid),
                   'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
                   'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE')
                 ) AS e
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND p.prosecdef
             AND p.prorettype <> 'pg_catalog.trigger'::regtype
             AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  OR has_function_privilege('anon', p.oid, 'EXECUTE'))
             AND pg_get_functiondef(p.oid) ~* '(^|[^a-z_])(insert into|update |delete from)'
             AND pg_get_functiondef(p.oid) !~ 'auth\.uid\(\)|auth\.role\(\)|auth\.jwt\(\)'
        ) s), '[]'::jsonb),

    -- 2. Executable by a LOGGED-OUT caller and writes, whatever it claims to
    --    check. Mentioning auth.uid() is not the same as being bound by it.
    'anon_writers', COALESCE((
      SELECT jsonb_agg(e ORDER BY e->>'function')
        FROM (
          SELECT jsonb_build_object(
                   'function', p.proname,
                   'args', pg_get_function_identity_arguments(p.oid)
                 ) AS e
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND p.prosecdef
             AND p.prorettype <> 'pg_catalog.trigger'::regtype
             AND has_function_privilege('anon', p.oid, 'EXECUTE')
             AND pg_get_functiondef(p.oid) ~* '(^|[^a-z_])(insert into|update |delete from)'
        ) s), '[]'::jsonb),

    -- 3. A table in `public` with RLS off that a browser role can WRITE. No
    --    policy stops it and no function stands in the way: the grant is the
    --    whole story. A new table created without RLS is the most expensive
    --    single mistake available in this schema, and it is silent.
    'rls_disabled_writable', COALESCE((
      SELECT jsonb_agg(e ORDER BY e->>'table')
        FROM (
          SELECT jsonb_build_object(
                   'table', c.relname,
                   'anon_write', (has_table_privilege('anon', c.oid, 'INSERT')
                               OR has_table_privilege('anon', c.oid, 'UPDATE')
                               OR has_table_privilege('anon', c.oid, 'DELETE')),
                   'authenticated_write', (has_table_privilege('authenticated', c.oid, 'INSERT')
                               OR has_table_privilege('authenticated', c.oid, 'UPDATE')
                               OR has_table_privilege('authenticated', c.oid, 'DELETE')),
                   'owner', pg_get_userbyid(c.relowner)
                 ) AS e
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public'
             AND c.relkind = 'r'
             AND NOT c.relrowsecurity
             AND (has_table_privilege('anon', c.oid, 'INSERT')
               OR has_table_privilege('anon', c.oid, 'UPDATE')
               OR has_table_privilege('anon', c.oid, 'DELETE')
               OR has_table_privilege('authenticated', c.oid, 'INSERT')
               OR has_table_privilege('authenticated', c.oid, 'UPDATE')
               OR has_table_privilege('authenticated', c.oid, 'DELETE'))
        ) s), '[]'::jsonb)
  );
$function$;

REVOKE ALL ON FUNCTION public.fn_definer_exposure_audit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_definer_exposure_audit() TO service_role;

COMMENT ON FUNCTION public.fn_definer_exposure_audit() IS
  'Three questions about live exposure: DEFINER writers a browser can reach that never consult the request, ANY writer a logged-out caller can execute, and tables with RLS off that a browser role can write. Read-only. Run daily by scripts/ci/audit-live-definer-exposure.mjs against a committed baseline. service_role only.';

DO $$
DECLARE r record; bad text := '';
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_horse_hash','fn_horse_hash_fnv','fn_horse_lane','fn_place_entitlement')
  LOOP
    IF r.proconfig IS NULL
       OR NOT EXISTS (SELECT 1 FROM unnest(r.proconfig) c WHERE c LIKE 'search_path=%') THEN
      bad := bad || r.sig || ' ';
    END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'search_path is still unpinned on: %', bad;
  END IF;
END $$;
