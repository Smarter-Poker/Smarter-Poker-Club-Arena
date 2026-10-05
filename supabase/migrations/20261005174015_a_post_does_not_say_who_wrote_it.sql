-- Applied to production as version 20261005174015 (match by name).
--
-- A POST DOES NOT SAY WHO WROTE IT
--
-- social_posts.origin_type was 'horse' on every clip a horse posted, and
-- social_posts.metadata carried the publishing pipeline's working notes
-- (scheduler, publication_contract, semantic_key, phrase_norm, ...) that only
-- ever appear on pipeline posts. Both were readable by anon and authenticated
-- through a table-level SELECT, so one REST call sorted the feed into bots and
-- people. World Hub #2130 (live 2026-10-05) stopped every browser read of
-- either column: browser reads name their columns, and a post's display
-- metadata is answered by /api/social/post with only the keys the UI renders.
--
-- This replaces the table-level SELECT for the browser roles with a column
-- list built from the catalogue, less those two columns, and proves it as each
-- role. A column added later is unreadable by the browser until it is granted,
-- so it fails closed. The service role is untouched.

REVOKE SELECT ON TABLE public.social_posts FROM anon, authenticated;
REVOKE SELECT (origin_type, metadata) ON TABLE public.social_posts FROM anon, authenticated;

DO $grant$
DECLARE v_cols text;
BEGIN
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.social_posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname NOT IN ('origin_type', 'metadata');
  EXECUTE format('GRANT SELECT (%s) ON TABLE public.social_posts TO anon, authenticated', v_cols);
END
$grant$;

DO $chk$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(a.attname, ',') INTO v_bad
    FROM pg_attribute a
   WHERE a.attrelid = 'public.social_posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND (has_column_privilege('anon', a.attrelid, a.attnum, 'SELECT') = (a.attname IN ('origin_type', 'metadata'))
       OR has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT') = (a.attname IN ('origin_type', 'metadata')));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'social_posts grants wrong for: %', v_bad;
  END IF;
  IF has_table_privilege('anon', 'public.social_posts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.social_posts', 'SELECT') THEN
    RAISE EXCEPTION 'a browser role still holds table-level SELECT on social_posts';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.social_posts', 'SELECT') THEN
    RAISE EXCEPTION 'the service role lost social_posts';
  END IF;
END
$chk$;

SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000000"}', true);
SET LOCAL ROLE authenticated;
DO $as_member$
BEGIN
  PERFORM p.id, p.author_id, p.content, p.created_at FROM public.social_posts p LIMIT 5;
  PERFORM r.id FROM public.social_reels r LIMIT 5;
  BEGIN
    PERFORM p.origin_type FROM public.social_posts p LIMIT 1;
    RAISE EXCEPTION 'authenticated still reads origin_type';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM p.metadata FROM public.social_posts p LIMIT 1;
    RAISE EXCEPTION 'authenticated still reads metadata';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$as_member$;
RESET ROLE;

SET LOCAL ROLE anon;
DO $as_visitor$
BEGIN
  PERFORM p.id, p.content FROM public.social_posts p LIMIT 5;
  BEGIN
    PERFORM p.origin_type FROM public.social_posts p LIMIT 1;
    RAISE EXCEPTION 'anon still reads origin_type';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM p.metadata FROM public.social_posts p LIMIT 1;
    RAISE EXCEPTION 'anon still reads metadata';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$as_visitor$;
RESET ROLE;

NOTIFY pgrst, 'reload schema';
