-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828045027; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
--  THE SWEEP THAT FOUND NINETEEN, REPEATED EVERY DAY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- On 2026-08-27 a hand-written query found 19 SECURITY DEFINER functions that
-- WRITE, that a browser role could execute, and that never referenced
-- auth.uid(), auth.role() or auth.jwt() - so they could not know who was
-- calling. One let an ordinary member rewrite a club's member_count from 592 to
-- 10,591. Another pays chips. Eighteen were revoked and two were reviewed and
-- kept.
--
-- check-definer-authorization.mjs stops a NEW one arriving through a migration
-- in this repository. It cannot see the live database, and this estate applies
-- schema straight to production through the Supabase MCP - which is exactly how
-- the nineteenth arrived hours after the sweep. A gate on the repo and no eye on
-- production leaves the door the nineteenth came through wide open.
--
-- So the sweep itself becomes a daily job. This function IS that query, run by
-- scripts/ci/audit-live-definer-exposure.mjs from the Schema Manifest Refresh
-- workflow, which already holds the service-role key and already runs at 05:20
-- UTC. It compares the answer against a committed baseline and raises a
-- self-closing issue when something new appears.
--
-- IT READS NOTHING BUT THE CATALOG and writes nothing at all. An auditor that
-- can change what it audits is not an auditor.
--
-- The predicate is deliberately identical to the one in the CI gate, in the
-- same words, so the two cannot drift into disagreeing about what is dangerous:
--
--   prosecdef                    SECURITY DEFINER
--   prorettype <> trigger        a trigger function cannot be invoked as an RPC
--   EXECUTE for a browser role   authenticated, anon, or PUBLIC
--   body writes                  insert into / update / delete from
--   body never consults          auth.uid() / auth.role() / auth.jwt()

CREATE OR REPLACE FUNCTION public.fn_definer_exposure_audit()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $function$
  SELECT COALESCE(jsonb_agg(x.entry ORDER BY x.entry->>'function'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
             'function', p.proname,
             'args', pg_get_function_identity_arguments(p.oid),
             'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
             'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE')
           ) AS entry
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND p.prorettype <> 'pg_catalog.trigger'::regtype
       AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
            OR has_function_privilege('anon', p.oid, 'EXECUTE'))
       AND pg_get_functiondef(p.oid) ~* '(^|[^a-z_])(insert into|update |delete from)'
       AND pg_get_functiondef(p.oid) !~ 'auth\.uid\(\)|auth\.role\(\)|auth\.jwt\(\)'
  ) x;
$function$;

REVOKE ALL ON FUNCTION public.fn_definer_exposure_audit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_definer_exposure_audit() TO service_role;

COMMENT ON FUNCTION public.fn_definer_exposure_audit() IS
  'Every SECURITY DEFINER function a browser role can execute that writes and never consults the request identity. Read-only. Run daily by scripts/ci/audit-live-definer-exposure.mjs against a committed baseline. service_role only.';

