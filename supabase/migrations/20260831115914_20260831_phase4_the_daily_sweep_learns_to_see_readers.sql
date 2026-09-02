-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831115914; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
--  THE DAILY SWEEP ASKS A FOURTH QUESTION: WHO CAN *READ* WITHOUT AN ACCOUNT?
-- ══════════════════════════════════════════════════════════════════════════
--
-- fn_definer_exposure_audit() asked three questions and every one of them was
-- about WRITES:
--
--   1. unauthenticated_writers   definer + writes + browser-reachable + no auth
--   2. anon_writers              definer + writes + anon can execute
--   3. rls_disabled_writable     table with RLS off a browser can write
--
-- On 2026-08-31 three SECURITY DEFINER functions were found anon-executable
-- that all three questions cleared, because not one of them writes a row:
--
--   fn_tournament_metrics    operator dashboard numbers
--   fn_truly_unused_indexes  table names, index names, sizes, scan counts
--   fn_nit_evictions         who was evicted from which table, and when
--
-- SECURITY DEFINER runs them as the owner, past RLS, for a caller with no
-- account, and none of them asks who that caller is. The middle one returns the
-- schema's table and index names; index names on this project encode their
-- columns, so that is a partial column map handed over for free.
--
-- Reading is not writing, and this is not the same severity as an anon writer.
-- It is still the reconnaissance step, and three arrived in a single afternoon
-- while a sweep that was supposed to be watching reported all clear.
--
-- QUESTION 4 IS DELIBERATELY THE NARROWEST ONE THAT CATCHES ALL THREE:
--
--   definer, not a trigger, anon can execute it, it does NOT write (question 2
--   already owns that, and far more loudly), and it never consults
--   auth.uid()/auth.role()/auth.jwt().
--
-- Consulting auth is the exemption because a function that asks who is calling
-- is at least AWARE there is a caller. One that never asks cannot be
-- authorising anything.
--
-- EXTENSION FUNCTIONS ARE EXCLUDED. PostGIS ships st_estimatedextent as three
-- SECURITY DEFINER overloads that anon can execute. They are not ours, revoking
-- them would be undone by the next extension upgrade, and leaving them in the
-- answer would put three permanent entries in a baseline whose whole value is
-- that a human read every line of it.
--
-- UNLIKE QUESTIONS 1 AND 2 THIS ONE HAS A BASELINE, and it has to: leaderboards,
-- name-availability checks and public profiles genuinely must answer a caller
-- with no account. The daily script fails on anything NEW, not on the list.

CREATE OR REPLACE FUNCTION public.fn_definer_exposure_audit()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
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

    -- 3. A table in `public` with RLS off that a browser role can WRITE. There
    --    is no policy to stop it and no function in the way: the grant is the
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
        ) s), '[]'::jsonb),

    -- 4. Executable by a LOGGED-OUT caller, reads, and never asks who is
    --    asking. Added 2026-08-31: questions 1-3 are all about writes, and
    --    three read-only functions walked past all of them in one afternoon.
    --    Extension-owned functions are excluded - PostGIS's st_estimatedextent
    --    overloads are not ours to revoke and would never leave the baseline.
    'anon_readers', COALESCE((
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
             AND pg_get_functiondef(p.oid) !~* '(^|[^a-z_])(insert into|update |delete from)'
             AND pg_get_functiondef(p.oid) !~ 'auth\.uid\(\)|auth\.role\(\)|auth\.jwt\(\)'
             AND NOT EXISTS (
               SELECT 1 FROM pg_depend d
                WHERE d.objid = p.oid
                  AND d.classid = 'pg_proc'::regclass
                  AND d.deptype = 'e'
             )
        ) s), '[]'::jsonb)
  );
$function$;

DO $$
DECLARE v jsonb; v_readers int; v_writers int;
BEGIN
  SELECT public.fn_definer_exposure_audit() INTO v;

  -- All four keys must be present, or the daily script reads undefined and
  -- reports a clean sweep it never ran.
  IF NOT (v ? 'unauthenticated_writers' AND v ? 'anon_writers'
          AND v ? 'rls_disabled_writable' AND v ? 'anon_readers') THEN
    RAISE EXCEPTION 'fn_definer_exposure_audit lost a key: %', jsonb_object_keys(v);
  END IF;

  v_writers := jsonb_array_length(v->'anon_writers');
  v_readers := jsonb_array_length(v->'anon_readers');

  -- The three questions that already existed must still answer zero.
  IF v_writers <> 0 THEN
    RAISE EXCEPTION 'anon_writers regressed to % - a logged-out caller can write', v_writers;
  END IF;

  -- Question 4 is expected to be NON-zero: it is the deliberate public surface
  -- (leaderboards, name availability, public profiles) that now gets baselined.
  -- Asserting it is non-empty proves the predicate actually runs; a silent zero
  -- here would be the bug this whole migration exists to prevent.
  IF v_readers = 0 THEN
    RAISE EXCEPTION 'anon_readers returned 0, which cannot be right - the predicate is broken';
  END IF;

  -- The one we just closed must NOT be in it any more.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v->'anon_readers') e
              WHERE e->>'function' = 'fn_truly_unused_indexes') THEN
    RAISE EXCEPTION 'fn_truly_unused_indexes is still anon-readable';
  END IF;

  RAISE NOTICE 'anon_readers baseline candidates: %', v_readers;
END $$;
