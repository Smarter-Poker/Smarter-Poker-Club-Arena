-- Applied to production as version 20261006024500 (match by name).
--
-- THE CONTENT ENGINE IS NOT READABLE BY A BROWSER
--
-- Found by the 2026-10-06 World Hub audit, confirmed with the publishable key:
--   bot_profiles  139 rows, ids like 'horse-103', 100 usernames matching live
--                 profiles - "Public can read bot profiles" (SELECT to public)
--   personas      100 rows (archetype, scrape sources) - "Public read access"
--   content_settings, pipeline_runs, content_schedule, content_stats,
--   clip_library  - the content engine's settings, run counts, schedule and
--                 clip library, each with a public SELECT policy
--   content_sources, content_asset_use - grantable, no browser reader
--   pipeline_stats - a security_invoker view over pipeline_runs
--   get_random_active_personas() - an invoker RPC callable by both roles
-- World Hub #2151 (live) moved the last browser readers (/horses settings and
-- pipeline tabs) behind operator routes on the service key. Nothing in Club
-- Arena or the World Hub browser reads any of these.
--
-- Also: trivia_pvp_matches.horse_side and trivia_pvp_queue.horse_wait_seconds /
-- horse_eligible_at were readable by the match participants (authenticated)
-- through a table-level SELECT; the matches table is in the Realtime
-- publication. They become column grants less those columns. Every trivia PvP
-- read in the World Hub goes through server routes and service RPCs.
--
-- @live-proof: (NOT has_table_privilege('anon', 'public.bot_profiles', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.personas', 'SELECT') AND NOT has_table_privilege('anon', 'public.content_settings', 'SELECT') AND NOT has_column_privilege('authenticated', 'public.trivia_pvp_matches', 'horse_side', 'SELECT') AND has_column_privilege('authenticated', 'public.trivia_pvp_matches', 'id', 'SELECT'))

DO $pre$
DECLARE v text;
BEGIN
  SELECT string_agg(tablename || '.' || policyname, ', ') INTO v
    FROM pg_policies
   WHERE tablename NOT IN ('bot_profiles', 'personas', 'content_settings', 'pipeline_runs', 'content_schedule',
                           'content_stats', 'clip_library', 'content_sources', 'content_asset_use')
     AND coalesce(qual, '') || coalesce(with_check, '') ~ '(bot_profiles|personas|content_settings|pipeline_runs|content_schedule|content_stats|clip_library|content_sources|content_asset_use)\M';
  IF v IS NOT NULL THEN RAISE EXCEPTION 'a policy on another table reads the content engine: %', v; END IF;

  SELECT string_agg(c.relname, ', ') INTO v
    FROM pg_class c
   WHERE c.relkind IN ('v', 'm') AND c.relnamespace = 'public'::regnamespace
     AND c.relname <> 'pipeline_stats'
     AND pg_get_viewdef(c.oid) ~ '(bot_profiles|personas|content_settings|pipeline_runs|content_schedule|content_stats|clip_library|content_sources|content_asset_use)\M'
     AND (has_table_privilege('anon', c.oid, 'SELECT') OR has_table_privilege('authenticated', c.oid, 'SELECT'));
  IF v IS NOT NULL THEN RAISE EXCEPTION 'a browser-readable view reads the content engine: %', v; END IF;

  SELECT string_agg(p.proname, ', ') INTO v
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND NOT p.prosecdef
     AND p.prorettype <> 'trigger'::regtype
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))
     AND p.prosrc ~ 'trivia_pvp_(matches|queue)'
     AND p.prosrc ~ 'horse_(side|wait_seconds|eligible_at)';
  IF v IS NOT NULL THEN RAISE EXCEPTION 'a browser-callable invoker function reads the trivia horse columns: %', v; END IF;
END
$pre$;

DROP POLICY IF EXISTS "Public can read bot profiles" ON public.bot_profiles;
DROP POLICY IF EXISTS "Public read access" ON public.personas;
DROP POLICY IF EXISTS "Allow public read on content_settings" ON public.content_settings;
DROP POLICY IF EXISTS "Allow public read on pipeline_runs" ON public.pipeline_runs;
DROP POLICY IF EXISTS content_schedule_select ON public.content_schedule;
DROP POLICY IF EXISTS content_stats_select ON public.content_stats;
DROP POLICY IF EXISTS clip_library_select ON public.clip_library;
DROP POLICY IF EXISTS clip_library_admin_write ON public.clip_library;

DO $revoke$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bot_profiles', 'personas', 'content_settings', 'pipeline_runs', 'content_schedule',
                           'content_stats', 'clip_library', 'content_sources', 'content_asset_use', 'pipeline_stats']
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
END
$revoke$;

REVOKE ALL ON FUNCTION public.get_random_active_personas(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_random_active_personas(integer) TO service_role;

DO $trivia$
DECLARE r record; v_cols text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('trivia_pvp_matches', ARRAY['horse_side']),
      ('trivia_pvp_queue', ARRAY['horse_wait_seconds', 'horse_eligible_at'])) x(tbl, withheld)
  LOOP
    EXECUTE format('REVOKE SELECT ON TABLE public.%I FROM anon, authenticated', r.tbl);
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_cols
      FROM pg_attribute a
     WHERE a.attrelid = ('public.' || r.tbl)::regclass AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname <> ALL (r.withheld);
    EXECUTE format('GRANT SELECT (%s) ON TABLE public.%I TO authenticated', v_cols, r.tbl);
  END LOOP;
END
$trivia$;

DO $post$
DECLARE v text;
BEGIN
  SELECT string_agg(format('%s on %s', rl, t), ', ') INTO v
    FROM unnest(ARRAY['anon', 'authenticated']) rl,
         unnest(ARRAY['bot_profiles', 'personas', 'content_settings', 'pipeline_runs', 'content_schedule',
                      'content_stats', 'clip_library', 'content_sources', 'content_asset_use', 'pipeline_stats']) t
   WHERE has_table_privilege(rl, 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE');
  IF v IS NOT NULL THEN RAISE EXCEPTION 'a browser role still reaches: %', v; END IF;

  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE tablename IN ('bot_profiles', 'personas', 'content_settings', 'pipeline_runs', 'content_schedule',
                                  'content_stats', 'clip_library', 'content_sources', 'content_asset_use')
                AND NOT (roles <@ ARRAY['service_role']::name[])) THEN
    RAISE EXCEPTION 'a non-service policy is still open on the content engine';
  END IF;

  IF has_function_privilege('anon', 'public.get_random_active_personas(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_random_active_personas(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_random_active_personas is still browser-callable';
  END IF;

  IF has_column_privilege('authenticated', 'public.trivia_pvp_matches', 'horse_side', 'SELECT')
     OR has_column_privilege('authenticated', 'public.trivia_pvp_queue', 'horse_wait_seconds', 'SELECT')
     OR has_column_privilege('authenticated', 'public.trivia_pvp_queue', 'horse_eligible_at', 'SELECT')
     OR has_table_privilege('authenticated', 'public.trivia_pvp_matches', 'SELECT')
     OR has_table_privilege('authenticated', 'public.trivia_pvp_queue', 'SELECT') THEN
    RAISE EXCEPTION 'a participant can still read a trivia horse column';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.trivia_pvp_matches', 'id', 'SELECT') THEN
    RAISE EXCEPTION 'participants lost the rest of their match';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.bot_profiles', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.trivia_pvp_matches', 'SELECT') THEN
    RAISE EXCEPTION 'the service role lost a table';
  END IF;
END
$post$;

NOTIFY pgrst, 'reload schema';
