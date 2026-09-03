-- A club header may never display another club's active-player total.
--
-- get_club_home historically counted every occupied seat on the platform and
-- returned that same number to every club. That made a brand-new empty club
-- report the Shark/union live total. Patch the deployed function in place so
-- every later projection and lobby feature remains intact, while applying the
-- same scope function already used by its tables and tournaments queries.
DO $$
DECLARE
  v_def text;
  v_anchor CONSTANT text :=
    '    AND tb.status IN (''waiting'', ''running'');';
  v_scoped CONSTANT text :=
    E'    AND tb.status IN (''waiting'', ''running'')\n'
    || E'    AND public.fn_club_home_in_scope(\n'
    || E'          tb.club_id, tb.is_private, tb.union_id,\n'
    || E'          v_union_id, v_club.id, v_union_club_ids);';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_club_home';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_club_home does not exist - refusing to guess';
  END IF;

  IF position('tb.club_id, tb.is_private, tb.union_id,' in v_def) > 0
     AND position(v_scoped in v_def) > 0 THEN
    RAISE NOTICE 'get_club_home already scopes players_playing';
    RETURN;
  END IF;

  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'players_playing query is not the expected shape';
  END IF;

  EXECUTE replace(v_def, v_anchor, v_scoped);
END $$;

-- Structural and behavioral post-apply proof. The newest club is sufficient
-- to prove the returned value follows that club's scope rather than a global
-- constant; the structural check protects every other club and union.
DO $$
DECLARE
  v_def text;
  v_club public.clubs%ROWTYPE;
  v_union_id uuid;
  v_union_club_ids uuid[];
  v_expected integer;
  v_actual integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_club_home';

  IF position('tb.club_id, tb.is_private, tb.union_id,' in v_def) = 0 THEN
    RAISE EXCEPTION 'players_playing is still platform-wide';
  END IF;

  SELECT * INTO v_club FROM public.clubs ORDER BY created_at DESC LIMIT 1;
  IF v_club.id IS NULL THEN
    RETURN;
  END IF;

  SELECT uc.union_id INTO v_union_id
  FROM public.union_clubs uc WHERE uc.club_id = v_club.id LIMIT 1;
  v_union_id := COALESCE(v_union_id, v_club.union_id);

  IF v_union_id IS NOT NULL THEN
    SELECT array_agg(uc.club_id) INTO v_union_club_ids
    FROM public.union_clubs uc WHERE uc.union_id = v_union_id;
  END IF;
  v_union_club_ids := COALESCE(v_union_club_ids, ARRAY[]::uuid[]) || v_club.id;

  SELECT count(DISTINCT ts.user_id)::int INTO v_expected
  FROM public.table_seats ts
  JOIN public.tables tb ON tb.id = ts.table_id
  WHERE ts.left_at IS NULL
    AND tb.status IN ('waiting', 'running')
    AND public.fn_club_home_in_scope(
          tb.club_id, tb.is_private, tb.union_id,
          v_union_id, v_club.id, v_union_club_ids);

  v_actual := (public.get_club_home(v_club.id::text)->>'players_playing')::integer;
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION '% reports % playing; scoped live seats say %',
      v_club.name, v_actual, v_expected;
  END IF;
END $$;
