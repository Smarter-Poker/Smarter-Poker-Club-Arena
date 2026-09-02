-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831115405; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Phase 3 of the 2026-08-31 hardening plan. Full rationale, the rolled-back
-- proof that trigger firing does not re-check EXECUTE, and the ROLLBACK
-- section live in supabase/migrations/20260831d_a_trigger_function_is_not_an_api.sql
--
-- Scoped to functions OWNED BY postgres: checkauthtrigger (Supabase auth) and
-- postgis_cache_bbox (PostGIS) belong to supabase_admin, and a REVOKE issued
-- by postgres against a grant postgres never made is a silent no-op. The first
-- run of this migration aborted on exactly that, which is why the assertion is
-- here and why the scope is explicit.

DO $$
DECLARE v_trigger_fns int; v_exposed int;
BEGIN
  SELECT count(*) INTO v_trigger_fns
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prorettype = 'trigger'::regtype;
  IF v_trigger_fns = 0 THEN
    RAISE EXCEPTION 'pre-flight failed: no trigger functions in public - wrong database?';
  END IF;

  SELECT count(*) INTO v_exposed
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prorettype = 'trigger'::regtype
    AND p.proowner = 'postgres'::regrole
    AND (has_function_privilege('anon', p.oid, 'execute')
      OR has_function_privilege('authenticated', p.oid, 'execute'));
  RAISE NOTICE 'pre-flight: % trigger functions total, % of ours exposed', v_trigger_fns, v_exposed;
END $$;

-- A trigger function is not an API.
DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public'
      AND p.prorettype = 'trigger'::regtype
      AND p.proowner = 'postgres'::regrole
      AND (has_function_privilege('anon', p.oid, 'execute')
        OR has_function_privilege('authenticated', p.oid, 'execute'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'revoked EXECUTE on % trigger function(s)', n;
END $$;

-- fn_union_eco_adjustment is SECURITY DEFINER with NO caller check and takes a
-- union id straight from the caller: any signed-in player could read another
-- union's economy figures. Zero call sites in either repo, so the door closes.
DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public'
      AND p.proname IN ('fn_union_eco_adjustment', 'fn_union_eco_record')
      AND p.proowner = 'postgres'::regrole
      AND (has_function_privilege('anon', p.oid, 'execute')
        OR has_function_privilege('authenticated', p.oid, 'execute'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'revoked EXECUTE on % union_eco function(s)', n;
END $$;

ALTER VIEW public.v_spin_unpaid_settlements SET (security_invoker = on);
ALTER VIEW public.v_spin_draw_booking_gaps  SET (security_invoker = on);

-- Prove BOTH halves: what we meant to close is closed, and what we promised
-- not to touch still works.
DO $$
DECLARE v_still int; v_eco int; v_invoker int;
BEGIN
  SELECT count(*) INTO v_still
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prorettype = 'trigger'::regtype
    AND p.proowner = 'postgres'::regrole
    AND (has_function_privilege('anon', p.oid, 'execute')
      OR has_function_privilege('authenticated', p.oid, 'execute'));
  IF v_still <> 0 THEN
    RAISE EXCEPTION 'post-apply failed: % of our trigger function(s) still browser-callable', v_still;
  END IF;

  SELECT count(*) INTO v_eco
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fn_union_eco_adjustment', 'fn_union_eco_record')
    AND (has_function_privilege('anon', p.oid, 'execute')
      OR has_function_privilege('authenticated', p.oid, 'execute'));
  IF v_eco <> 0 THEN
    RAISE EXCEPTION 'post-apply failed: a union_eco reader is still browser-callable';
  END IF;

  SELECT count(*) INTO v_invoker
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('v_spin_unpaid_settlements', 'v_spin_draw_booking_gaps')
    AND array_to_string(c.reloptions, ',') LIKE '%security_invoker=on%';
  IF v_invoker <> 2 THEN
    RAISE EXCEPTION 'post-apply failed: expected 2 security_invoker views, found %', v_invoker;
  END IF;

  RAISE NOTICE 'post-apply OK: trigger functions closed, union_eco closed, views are invoker';
END $$;
