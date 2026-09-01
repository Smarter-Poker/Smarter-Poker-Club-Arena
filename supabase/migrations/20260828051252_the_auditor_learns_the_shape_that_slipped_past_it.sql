-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828051252; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
--  THE AUDITOR LEARNS THE SHAPE THAT SLIPPED PAST IT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_definer_exposure_audit asked one question: which SECURITY DEFINER writers
-- can a browser reach that NEVER reference auth.uid(), auth.role() or auth.jwt()
-- - functions that cannot know who is calling. That found nineteen, then two
-- more on its first scheduled shape.
--
-- It MISSED process_tournament_rebuy, which was live-exploitable by anyone
-- holding the public anon key: an unauthenticated call bought a rebuy for a real
-- seated player and took the chips out of their balance. It missed it because
-- that function DOES reference auth.uid() - just uselessly:
--
--     IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN ... refuse
--
-- which skips the check entirely for a caller who has no auth.uid() at all.
-- Mentioning the request is not the same as being bound by it, and a predicate
-- built on "does it mention auth" cannot tell those apart.
--
-- So the auditor gains a second, blunter question that needs no reasoning about
-- guard logic at all:
--
--     can `anon` execute a SECURITY DEFINER function that WRITES?
--
-- No logged-out visitor should be able to invoke a writing function, whatever
-- its internal checks say, because the only thing standing between a fail-open
-- guard and a live exploit is that grant. After the rebuy fix the live answer is
-- ZERO, so it is a clean invariant with nothing to forgive - the strongest form
-- a rule can take.
--
-- Two questions, one auditor (RULE 12). The return shape becomes an object so
-- the script can report them separately; both are compared against
-- scripts/ci/definer-exposure-baseline.json.

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
    --    check. This is the question that would have caught the rebuy hole:
    --    mentioning auth.uid() is not the same as being bound by it.
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
        ) s), '[]'::jsonb)
  );
$function$;

REVOKE ALL ON FUNCTION public.fn_definer_exposure_audit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_definer_exposure_audit() TO service_role;

COMMENT ON FUNCTION public.fn_definer_exposure_audit() IS
  'Two questions about live DEFINER exposure: writers a browser can reach that never consult the request, and ANY writer a logged-out caller can execute. Read-only. Run daily by scripts/ci/audit-live-definer-exposure.mjs against a committed baseline. service_role only.';

