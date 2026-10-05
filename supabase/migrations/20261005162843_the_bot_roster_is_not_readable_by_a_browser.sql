-- Applied to production as version 20261005162843 (match by name).
--
-- THE BOT ROSTER IS NOT READABLE BY A BROWSER
--
-- Dan, 2026-09-02: "NOBODY SHOULD EVER EVER EVER BE ABLE TO LOOK AT OUR CODE
-- OR USE A DEVELOPER TOOL AND FIND THIS OUT."
--
-- public.content_authors holds one row per house account: 1,000 of 1,000
-- profile_ids on 2026-10-05 are horses. It was readable by anyone, logged out
-- included ("Public can read authors", SELECT to public, plus a table-level
-- grant of every privilege to anon and authenticated), so one REST call
-- listed every bot. The World Hub feed and profile page downloaded it for the
-- online dot; World Hub #2127 moved those reads behind server routes, which
-- use the service role. Nothing a browser runs reads these objects any more.
--
-- This closes the door in the database:
--   * content_authors and clip_usage_log (which clip each horse posted): every
--     policy dropped and every privilege revoked from anon, authenticated and
--     PUBLIC, including on the id sequence. RLS stays on, so with no policy a
--     browser role reads nothing even if a grant were ever restored by mistake;
--   * the invoker RPCs that walk the roster (fn_horses_without_social_identity,
--     fn_horses_not_social_ready, fn_mint_social_alias, get_random_clip,
--     mark_clip_used) lose EXECUTE for every role but service_role.
-- The service role keeps its explicit grants, so the pipeline, the hub API
-- routes and the engine are unaffected.

DO $pre$
DECLARE v text;
BEGIN
  -- A policy on another table that reads the roster would start failing for
  -- browsers once the grant is gone. There is none; refuse if one appears.
  SELECT string_agg(tablename || '.' || policyname, ', ') INTO v
    FROM pg_policies
   WHERE tablename NOT IN ('content_authors', 'clip_usage_log')
     AND coalesce(qual, '') || coalesce(with_check, '') ~ '(content_authors|clip_usage_log)';
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'a policy on another table reads the roster: %', v;
  END IF;

  SELECT string_agg(c.relname, ', ') INTO v
    FROM pg_class c
   WHERE c.relkind IN ('v', 'm')
     AND pg_get_viewdef(c.oid) ~ '(content_authors|clip_usage_log)';
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'a view reads the roster: %', v;
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.content_authors'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.clip_usage_log'::regclass) THEN
    RAISE EXCEPTION 'row level security is off on a roster table';
  END IF;
END
$pre$;

DROP POLICY IF EXISTS "Public can read authors" ON public.content_authors;
DROP POLICY IF EXISTS "Admins manage authors" ON public.content_authors;
DROP POLICY IF EXISTS "Anyone can view clip usage" ON public.clip_usage_log;

REVOKE ALL ON TABLE public.content_authors FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.clip_usage_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.content_authors TO service_role;
GRANT ALL ON TABLE public.clip_usage_log TO service_role;

DO $seq$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT s.oid::regclass AS seq
      FROM pg_depend d
      JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
     WHERE d.refobjid IN ('public.content_authors'::regclass, 'public.clip_usage_log'::regclass)
       AND d.deptype IN ('a', 'i')
  LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated', r.seq);
    EXECUTE format('GRANT ALL ON SEQUENCE %s TO service_role', r.seq);
  END LOOP;
END
$seq$;

DO $fn$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('fn_horses_without_social_identity', 'fn_horses_not_social_ready',
                         'fn_mint_social_alias', 'get_random_clip', 'mark_clip_used')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.fn);
  END LOOP;
END
$fn$;

DO $post$
DECLARE v text;
BEGIN
  SELECT string_agg(format('%s on %s', rl, t), ', ') INTO v
    FROM unnest(ARRAY['anon', 'authenticated']) rl,
         unnest(ARRAY['public.content_authors', 'public.clip_usage_log']) t
   WHERE has_table_privilege(rl, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'a browser role still holds a privilege: %', v;
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('fn_horses_without_social_identity', 'fn_horses_not_social_ready',
                       'fn_mint_social_alias', 'get_random_clip', 'mark_clip_used')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
          OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE'));
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'a roster RPC is still callable by a browser, or not by the service role: %', v;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename IN ('content_authors', 'clip_usage_log')) THEN
    RAISE EXCEPTION 'a policy is still open on a roster table';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.content_authors', 'SELECT,INSERT,UPDATE,DELETE')
     OR NOT has_table_privilege('service_role', 'public.clip_usage_log', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'the service role lost the roster';
  END IF;
END
$post$;
