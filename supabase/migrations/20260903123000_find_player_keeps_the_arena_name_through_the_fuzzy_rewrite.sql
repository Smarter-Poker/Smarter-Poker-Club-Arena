-- ============================================================================
-- FIND PLAYER KEEPS THE ARENA NAME THROUGH THE FUZZY REWRITE
--
-- 20260903120000 made fn_search_players answer with the arena name. Hours
-- later 20260902214500_player_search_fuzzy_and_affiliations (trigram search +
-- affiliations, a good change) replaced the whole function and, having been
-- written against the older body, went back to emitting p.display_name - the
-- column that is an exact copy of full_name on 264 of 1,308 profiles. It was
-- applied to production AFTER the fix, so Find Player was answering with real
-- names again by the time anyone looked.
--
-- This does NOT revert the fuzzy search. It re-applies the arena name onto the
-- current definition, as three minimal edits:
--   1. `matched` computes arena_name from the resolver,
--   2. the JSON payload emits arena_name in place of display_name,
--   3. the name sort orders by arena_name.
-- Everything else - trigram matching, similarity thresholds, affiliations,
-- authorisation - is untouched, and the round-trip assertion proves it.
--
-- The WHERE clause still matches on display_name so a staff member who types a
-- real name still FINDS the account. Searching is a lookup; displaying is a
-- disclosure.
--
-- THE LESSON IS THE SHAPE OF IT. Two agents edited the same function from
-- different branches and the later apply silently undid the earlier. Neither
-- did anything wrong locally. tests/theArenaIsAlwaysTheAlias.law.test.ts now
-- asserts that the LAST migration to define fn_search_players carries
-- fn_arena_name, so the next person to rewrite this function is told by CI
-- rather than by a player seeing their own legal name in a search result.
--
-- ROLLBACK: apply the inverse of the three replacements below; they are
-- written out verbatim in the assertion.
-- ============================================================================

BEGIN;

DO $mig$
DECLARE
  v_old text;
  v_new text;
  v_back text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_old
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.proname = 'fn_search_players';

  IF v_old IS NULL THEN
    RAISE EXCEPTION 'fn_search_players not found';
  END IF;

  IF v_old ILIKE '%fn_arena_name%' THEN
    RAISE NOTICE 'fn_search_players already resolves the arena name; nothing to do';
    RETURN;
  END IF;

  v_new := replace(
    v_old,
    'SELECT p.id, p.username, p.display_name,',
    'SELECT p.id, p.username, p.display_name,' || chr(10) ||
    '           public.fn_arena_name(p.alias, p.username, p.display_name,' || chr(10) ||
    '                                p.first_name, p.last_name, p.full_name) AS arena_name,'
  );
  v_new := replace(v_new, $q$'display_name', display_name,$q$, $q$'display_name', arena_name,$q$);
  v_new := replace(v_new,
    $q$lower(coalesce(display_name, username, ''))$q$,
    $q$lower(coalesce(arena_name, username, ''))$q$);

  IF v_new = v_old THEN
    RAISE EXCEPTION 'none of the three anchors matched - fn_search_players has changed shape, review by hand';
  END IF;

  -- Collapse all three edits back and demand the original, byte for byte.
  v_back := replace(v_new,
    'SELECT p.id, p.username, p.display_name,' || chr(10) ||
    '           public.fn_arena_name(p.alias, p.username, p.display_name,' || chr(10) ||
    '                                p.first_name, p.last_name, p.full_name) AS arena_name,',
    'SELECT p.id, p.username, p.display_name,');
  v_back := replace(v_back, $q$'display_name', arena_name,$q$, $q$'display_name', display_name,$q$);
  v_back := replace(v_back,
    $q$lower(coalesce(arena_name, username, ''))$q$,
    $q$lower(coalesce(display_name, username, ''))$q$);

  IF v_back IS DISTINCT FROM v_old THEN
    RAISE EXCEPTION 'rewrite of fn_search_players changed something other than the name expression';
  END IF;

  EXECUTE v_new;
END
$mig$;

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.proname = 'fn_search_players';
  IF v_def NOT ILIKE '%fn_arena_name%' THEN
    RAISE EXCEPTION 'fn_search_players still answers with a raw display_name';
  END IF;
  -- The fuzzy search this was rebased onto must still be there.
  IF v_def NOT ILIKE '%similarity(%' THEN
    RAISE EXCEPTION 'the trigram search was lost - this migration must not revert 20260902214500';
  END IF;
END $$;

COMMIT;
