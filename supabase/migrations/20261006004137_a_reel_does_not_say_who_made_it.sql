-- Applied to production as version 20261006004137 (match by name).
--
-- A REEL DOES NOT SAY WHO MADE IT
--
-- social_reels.origin_type is 'horse' on every Reel a horse published (204
-- rows, 185 authors) and on nothing else, and it was readable by both browser
-- roles through a table-level SELECT. World Hub #2144 (live 2026-10-06,
-- 824fddc) stopped every browser read and every API response carrying it. This
-- replaces the browser roles' table-level SELECT with a catalogue-built column
-- grant less origin_type (Realtime then drops it from payloads too) and proves
-- it as each role. A column added later is unreadable by the browser until it
-- is granted, so it fails closed.
--
-- @live-proof: (NOT has_table_privilege('anon', 'public.social_reels', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.social_reels', 'SELECT') AND NOT has_column_privilege('anon', 'public.social_reels', 'origin_type', 'SELECT') AND NOT has_column_privilege('authenticated', 'public.social_reels', 'origin_type', 'SELECT') AND has_column_privilege('anon', 'public.social_reels', 'caption', 'SELECT'))

DO $preflight$
DECLARE v text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.social_reels'::regclass
                  AND attname = 'origin_type' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'social_reels.origin_type is missing; the catalogue changed, re-review';
  END IF;
  SELECT string_agg(schemaname||'.'||tablename||':'||policyname, ', ') INTO v FROM pg_policies
   WHERE tablename <> 'social_reels' AND (coalesce(qual,'')||' '||coalesce(with_check,'')) ~* 'social_reels';
  IF v IS NOT NULL THEN RAISE EXCEPTION 'policies on other tables read social_reels: %', v; END IF;
  SELECT string_agg(schemaname||'.'||viewname, ', ') INTO v FROM pg_views
   WHERE schemaname NOT IN ('pg_catalog','information_schema')
     AND definition ~* 'social_reels' AND definition ~* 'origin_type';
  IF v IS NOT NULL THEN RAISE EXCEPTION 'views read social_reels.origin_type: %', v; END IF;
  SELECT string_agg(n.nspname||'.'||p.proname, ', ') INTO v
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND NOT p.prosecdef
     AND p.prosrc ~* 'social_reels' AND p.prosrc ~* 'origin_type';
  IF v IS NOT NULL THEN RAISE EXCEPTION 'security-invoker functions read social_reels.origin_type: %', v; END IF;
END
$preflight$;

REVOKE SELECT ON TABLE public.social_reels FROM anon, authenticated;
REVOKE SELECT (origin_type) ON TABLE public.social_reels FROM anon, authenticated;

DO $grant$
DECLARE v_cols text;
BEGIN
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.social_reels'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname <> 'origin_type';
  EXECUTE format('GRANT SELECT (%s) ON TABLE public.social_reels TO anon, authenticated', v_cols);
END
$grant$;

DO $chk$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(a.attname, ',') INTO v_bad
    FROM pg_attribute a
   WHERE a.attrelid = 'public.social_reels'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND (has_column_privilege('anon', a.attrelid, a.attnum, 'SELECT') = (a.attname = 'origin_type')
       OR has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT') = (a.attname = 'origin_type'));
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'social_reels grants wrong for: %', v_bad; END IF;
  IF has_table_privilege('anon', 'public.social_reels', 'SELECT')
     OR has_table_privilege('authenticated', 'public.social_reels', 'SELECT') THEN
    RAISE EXCEPTION 'a browser role still holds table-level SELECT on social_reels';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.social_reels', 'SELECT') THEN
    RAISE EXCEPTION 'the service role lost social_reels';
  END IF;
END
$chk$;

SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000000"}', true);
SET LOCAL ROLE authenticated;
DO $as_member$
BEGIN
  PERFORM r.id, r.author_id, r.caption, r.video_url, r.source_type, r.playback_type, r.topic, r.like_count
     FROM public.social_reels r WHERE r.is_public LIMIT 5;
  PERFORM 1 FROM public.v_yt_pipeline_health LIMIT 1;
  PERFORM p.id FROM public.social_posts p LIMIT 5;
  BEGIN
    PERFORM r.origin_type FROM public.social_reels r LIMIT 1;
    RAISE EXCEPTION 'authenticated still reads origin_type';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM r.* FROM public.social_reels r LIMIT 1;
    RAISE EXCEPTION 'authenticated still reads every column';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$as_member$;
RESET ROLE;

SET LOCAL ROLE anon;
DO $as_visitor$
BEGIN
  PERFORM r.id, r.caption, r.video_url FROM public.social_reels r WHERE r.is_public LIMIT 5;
  PERFORM 1 FROM public.v_yt_pipeline_health LIMIT 1;
  BEGIN
    PERFORM r.origin_type FROM public.social_reels r LIMIT 1;
    RAISE EXCEPTION 'anon still reads origin_type';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$as_visitor$;
RESET ROLE;

NOTIFY pgrst, 'reload schema';
