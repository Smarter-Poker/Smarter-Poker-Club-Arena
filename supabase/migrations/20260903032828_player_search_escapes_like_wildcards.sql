-- 20260903032828_player_search_escapes_like_wildcards.sql
-- RECOVERED 2026-09-03 from supabase_migrations.schema_migrations.
-- This migration was APPLIED to production on 2026-09-03 at 03:28:28 UTC but was never committed, so the repo
-- could not reproduce the database and applied-migrations-recorded.yml was red.
-- The body below is the exact SQL the database recorded; it is NOT a
-- reconstruction. Re-applying it is a no-op - it is already in production.

DO $mig$
DECLARE
  v_src text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_search_players';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_search_players not found';
  END IF;

  -- Derive the new body from the LIVE definition rather than retyping 400
  -- lines, so production cannot drift from the reviewed source by a typo.
  -- Every replacement is exact and asserted below.
  v_new := v_src;

  -- 1. Declare the escaped term next to the raw one.
  v_new := replace(v_new,
    E'  v_query text := lower(btrim(coalesce(p_query, \'\')));\n',
    E'  v_query text := lower(btrim(coalesce(p_query, \'\')));\n  v_like text;\n');

  -- 2. Compute it. Backslash first, or it escapes the escapes added after it.
  v_new := replace(v_new,
    E'  v_fuzzy := length(v_query) >= 3;',
    E'  v_like := replace(replace(replace(v_query, \'\\\', \'\\\\\'), \'%\', \'\\%\'), \'_\', \'\\_\');\n\n  v_fuzzy := length(v_query) >= 3;');

  -- 3. Every LIKE pattern uses the escaped term. Equality, the trigram %
  --    operator and similarity() keep the raw query untouched.
  v_new := replace(v_new, E'LIKE \'%\' || v_query || \'%\'', E'LIKE \'%\' || v_like || \'%\' ESCAPE \'\\\'');
  v_new := replace(v_new, E'LIKE v_query || \'%\'', E'LIKE v_like || \'%\' ESCAPE \'\\\'');

  IF position('v_like' IN v_new) = 0 THEN
    RAISE EXCEPTION 'escaped term was never introduced - source shape changed';
  END IF;
  IF position(E'LIKE \'%\' || v_query' IN v_new) > 0 OR position('LIKE v_query' IN v_new) > 0 THEN
    RAISE EXCEPTION 'a LIKE pattern still reads the unescaped query';
  END IF;

  EXECUTE v_new;
END;
$mig$;

REVOKE ALL ON FUNCTION public.fn_search_players(text, integer, integer, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_search_players(text, integer, integer, text, text, text)
  TO authenticated, service_role;

DO $assert$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_search_players';

  IF position(E'LIKE \'%\' || v_query' IN v_src) > 0 OR position('LIKE v_query' IN v_src) > 0 THEN
    RAISE EXCEPTION 'a LIKE pattern is built from the unescaped query again';
  END IF;
  IF position('v_like' IN v_src) = 0 THEN
    RAISE EXCEPTION 'the escaped LIKE term is gone';
  END IF;
  IF position('hidden_count' IN v_src) > 0 THEN
    RAISE EXCEPTION 'affiliations returns a count of hidden clubs again';
  END IF;
  IF position('c.is_private' IN v_src) > 0 THEN
    RAISE EXCEPTION 'is_gated is keyed off the dead c.is_private flag again';
  END IF;
  IF position('lower(p.username) %' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fuzzy predicate lost its indexable username clause';
  END IF;
  IF position('player_search_preferences' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_search_players no longer reads player_search_preferences';
  END IF;
  IF position('viewer_seated' IN v_src) = 0 THEN
    RAISE EXCEPTION 'search payload no longer distinguishes the viewer own seat';
  END IF;
END;
$assert$;