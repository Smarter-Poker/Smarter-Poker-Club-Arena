-- ============================================================================
-- REHEARSAL (rolled back; run by rehearse.sh after migration 20260930234000):
-- the owner door, the staff door, the eleven moved readers, and the same
-- readers under the step-2 column revoke, simulated inside this transaction.
-- Fixture accounts only (fn_ca_is_fixture_account); nothing persists. Ends in
-- a deliberate error: REHEARSAL OK is the success line.
-- ============================================================================
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
CREATE FUNCTION pg_temp.as_client(p_uid uuid) RETURNS void LANGUAGE sql AS $f$
  SELECT set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$f$;
DO $r$
DECLARE
  c_staff constant uuid := '00000000-0000-0000-0000-000000000001';
  c_u1    constant uuid := '00000000-0000-0000-0000-000000000056';
  c_u2    constant uuid := '00000000-0000-0000-0000-000000000073';
  v_private constant text[] := ARRAY['diamonds','diamond_balance','diamond_multiplier','first_name','last_name',
    'full_name','birth_year','city','state','country','last_seen','last_login','last_login_date','last_active',
    'updated_at','referred_by','poker_near_me_preferences'];
  v_u1 public.profiles;
  v_u2 public.profiles;
  v_row record;
  v_n integer;
  v_j jsonb;
  v_t text;
  v_club uuid;
  v_story uuid;
  v_report text := '';
  v_t0 timestamptz := clock_timestamp();
BEGIN
  -- Fixture accounts only.
  IF NOT (public.fn_ca_is_fixture_account(c_staff) AND public.fn_ca_is_fixture_account(c_u1)
          AND public.fn_ca_is_fixture_account(c_u2)) THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: a rehearsal identity is not a fixture account';
  END IF;
  -- Private fields a stranger must not see, set by hand on the fixtures.
  UPDATE public.profiles SET role = 'admin' WHERE id = c_staff;
  UPDATE public.profiles SET full_name = 'Rehearsal Person Two', first_name = 'Rehearsal', last_name = 'Two',
         city = 'Rehearsal City', state = 'RS', country = 'RC', birth_year = 1990 WHERE id = c_u2;
  UPDATE public.profiles SET full_name = 'Rehearsal Person One', city = 'Own City', state = 'OS' WHERE id = c_u1;
  UPDATE public.profiles SET is_online = true, last_seen = now() WHERE id = c_u2;
  SELECT m.club_id INTO v_club FROM public.club_members m GROUP BY m.club_id ORDER BY count(*) DESC LIMIT 1;
  INSERT INTO public.social_stories (author_id, content, expires_at)
       VALUES (c_u2, 'rehearsal story', now() + interval '1 hour') RETURNING id INTO v_story;
  INSERT INTO public.social_follows (follower_id, following_id) VALUES (c_u1, c_u2);
  -- Read after the inserts: a social trigger may credit a fixture.
  SELECT * INTO v_u1 FROM public.profiles WHERE id = c_u1;
  SELECT * INTO v_u2 FROM public.profiles WHERE id = c_u2;

  -- 1. The owner door answers with the caller's own row and nothing else.
  PERFORM pg_temp.as_client(c_u1);
  SET LOCAL ROLE authenticated;
  SELECT count(*), max(g.id::text) INTO v_n, v_t FROM public.get_my_full_profile() g;
  IF v_n <> 1 OR v_t <> c_u1::text THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: owner door answered % rows, id %', v_n, v_t;
  END IF;
  SELECT g.diamonds, g.full_name, g.city, g.last_seen, g.updated_at INTO v_row FROM public.get_my_full_profile() g;
  IF v_row.diamonds IS DISTINCT FROM v_u1.diamonds OR v_row.full_name IS DISTINCT FROM v_u1.full_name
     OR v_row.city IS DISTINCT FROM v_u1.city OR v_row.last_seen IS DISTINCT FROM v_u1.last_seen THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: owner door fields differ from the row: door % / row % % % %', v_row, v_u1.diamonds, v_u1.full_name, v_u1.city, v_u1.last_seen;
  END IF;
  v_report := v_report || ' owner=own-row';
  -- Presence answers a boolean for a fresh heartbeat, and never the heartbeat.
  SELECT count(*) INTO v_n FROM public.fn_profile_presence(ARRAY[c_u2]) x;
  IF v_n <> 1 OR NOT (SELECT x.is_online FROM public.fn_profile_presence(ARRAY[c_u2]) x) THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: presence of a fresh heartbeat';
  END IF;
  RESET ROLE;
  UPDATE public.profiles SET last_seen = now() - interval '10 minutes' WHERE id = c_u2;
  SET LOCAL ROLE authenticated;
  IF (SELECT x.is_online FROM public.fn_profile_presence(ARRAY[c_u2]) x) THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: a stale heartbeat still reads online';
  END IF;
  v_report := v_report || ' presence=fresh-online,stale-offline';

  -- 2. The staff door refuses a player by name, and a visitor cannot call it.
  BEGIN
    PERFORM 1 FROM public.get_full_profiles_for_staff(ARRAY[c_u2]);
    RAISE EXCEPTION 'REHEARSAL FAIL: a player read the staff door';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%read only by its owner and by platform staff%' THEN RAISE; END IF;
  END;
  RESET ROLE;
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM 1 FROM public.get_full_profiles_for_staff(ARRAY[c_u2]);
    RAISE EXCEPTION 'REHEARSAL FAIL: a visitor read the staff door';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.fn_profile_presence(ARRAY[c_u2]);
    RAISE EXCEPTION 'REHEARSAL FAIL: a visitor read presence';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- The signed-out profile page: no legal name and no balance.
  SELECT * INTO v_row FROM public.get_public_profile_by_username(v_u2.username);
  IF v_row.username IS DISTINCT FROM v_u2.username OR v_row.full_name IS NOT NULL OR v_row.diamonds IS NOT NULL THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: public profile still answers with a legal name or a balance';
  END IF;
  RESET ROLE;
  v_report := v_report || ' staff=refused(player,visitor) public-profile=no-name,no-balance';

  -- 3. Staff read a player's private fields.
  PERFORM pg_temp.as_client(c_staff);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.get_full_profiles_for_staff(ARRAY[c_u1, c_u2]);
  SELECT s.full_name, s.city, s.birth_year INTO v_row FROM public.get_full_profiles_for_staff(ARRAY[c_u2]) s;
  IF v_n <> 2 OR v_row.full_name IS DISTINCT FROM 'Rehearsal Person Two' OR v_row.city IS DISTINCT FROM 'Rehearsal City'
     OR v_row.birth_year IS DISTINCT FROM 1990 THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: staff door answered % rows / %', v_n, v_row;
  END IF;
  RESET ROLE;
  v_report := v_report || ' staff=reads';

  -- 4. Another player's city is theirs alone on the unified profile.
  PERFORM pg_temp.as_client(c_u1);
  SET LOCAL ROLE authenticated;
  v_j := public.get_unified_user_profile(c_u2);
  IF (v_j->'profile'->>'city') IS NOT NULL OR (v_j->'profile'->>'state') IS NOT NULL
     OR (v_j->'profile'->>'full_name') IS NOT NULL OR (v_j->'profile'->>'diamonds') IS NOT NULL THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: unified profile shows a stranger''s private fields: %', v_j->'profile';
  END IF;
  v_j := public.get_unified_user_profile(c_u1);
  IF (v_j->'profile'->>'city') IS DISTINCT FROM 'Own City' OR (v_j->'profile'->>'state') IS DISTINCT FROM 'OS' THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: unified profile hides the owner''s own city: %', v_j->'profile';
  END IF;
  -- Baseline before the revoke: the story bar names the author publicly.
  v_j := public.fn_get_stories(c_u1);
  SELECT e->>'author_fullname' INTO v_t FROM jsonb_array_elements(v_j) e WHERE (e->>'id')::uuid = v_story;
  IF v_t IS NULL OR v_t = 'Rehearsal Person Two' OR v_t IS DISTINCT FROM COALESCE(v_u2.display_name, v_u2.username) THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: story author before the revoke is %', v_t;
  END IF;
  RESET ROLE;
  v_report := v_report || ' unified=owner-only-city story=' || quote_literal(v_t);

  -- 5. The step-2 revoke, simulated: the private columns leave authenticated.
  EXECUTE format('REVOKE SELECT (%s) ON public.profiles FROM authenticated, anon',
                 (SELECT string_agg(quote_ident(c), ', ') FROM unnest(v_private) c));
  SELECT count(*) INTO v_n FROM unnest(v_private) c
   WHERE has_column_privilege('authenticated', 'public.profiles', c, 'SELECT');
  IF v_n <> 0 THEN RAISE EXCEPTION 'REHEARSAL FAIL: % private columns still readable', v_n; END IF;

  PERFORM pg_temp.as_client(c_u1);
  SET LOCAL ROLE authenticated;
  -- A stranger is refused a private column, and so is the owner by the table:
  -- column grants are not per row, so the owner reads through the door.
  BEGIN
    PERFORM p.full_name FROM public.profiles p WHERE p.id = c_u2;
    RAISE EXCEPTION 'REHEARSAL FAIL: a stranger read full_name after the revoke';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM p.diamonds FROM public.profiles p WHERE p.id = c_u1;
    RAISE EXCEPTION 'REHEARSAL FAIL: diamonds readable from the table after the revoke';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.profiles p WHERE p.city = 'Rehearsal City';
    RAISE EXCEPTION 'REHEARSAL FAIL: a filter on city ran after the revoke';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- The public columns still read.
  SELECT count(*) INTO v_n FROM public.profiles p
   WHERE p.id = c_u2 AND p.username IS NOT DISTINCT FROM v_u2.username
     AND p.display_name IS NOT DISTINCT FROM v_u2.display_name AND p.alias IS NOT DISTINCT FROM v_u2.alias
     AND p.avatar_url IS NOT DISTINCT FROM v_u2.avatar_url AND p.arena_avatar_url IS NOT DISTINCT FROM v_u2.arena_avatar_url
     AND p.player_number IS NOT DISTINCT FROM v_u2.player_number AND p.level IS NOT DISTINCT FROM v_u2.level
     AND p.is_online IS NOT DISTINCT FROM v_u2.is_online AND p.created_at IS NOT DISTINCT FROM v_u2.created_at;
  IF v_n <> 1 THEN RAISE EXCEPTION 'REHEARSAL FAIL: public columns did not read after the revoke'; END IF;
  -- The owner door still answers with the owner's own private fields.
  SELECT g.diamonds, g.full_name, g.city, g.updated_at INTO v_row FROM public.get_my_full_profile() g;
  IF v_row.diamonds IS DISTINCT FROM v_u1.diamonds OR v_row.full_name IS DISTINCT FROM 'Rehearsal Person One'
     OR v_row.city IS DISTINCT FROM 'Own City' THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: owner door after the revoke: %', v_row;
  END IF;
  -- The owner still edits their own private fields (UPDATE is not revoked).
  UPDATE public.profiles SET city = 'Edited City', full_name = 'Edited Name' WHERE id = c_u1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'REHEARSAL FAIL: the owner could not edit their own row'; END IF;
  -- An upsert that names a private column is refused (EXCLUDED is a read).
  BEGIN
    INSERT INTO public.profiles (id, full_name) VALUES (c_u1, 'Upserted')
      ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
    RAISE EXCEPTION 'REHEARSAL FAIL: an upsert naming full_name ran after the revoke';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- Presence still answers under the revoke.
  RESET ROLE;
  UPDATE public.profiles SET last_seen = now() WHERE id = c_u2;
  SET LOCAL ROLE authenticated;
  IF NOT (SELECT x.is_online FROM public.fn_profile_presence(ARRAY[c_u2]) x) THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: presence under the revoke';
  END IF;
  -- The moved invoker readers run under the revoke.
  v_j := to_jsonb(public.get_top_mission_completers(v_club, 3));
  v_j := public.fn_get_stories(c_u1);
  SELECT e->>'author_fullname' INTO v_t FROM jsonb_array_elements(v_j) e WHERE (e->>'id')::uuid = v_story;
  IF v_t IS DISTINCT FROM COALESCE(v_u2.display_name, v_u2.username) THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: the story bar lost its author under the revoke (got %)', v_t;
  END IF;
  -- The unified profile (a definer) still answers the owner.
  v_j := public.get_unified_user_profile(c_u1);
  IF (v_j->'profile'->>'city') IS DISTINCT FROM 'Edited City' THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: unified profile after the revoke: %', v_j->'profile';
  END IF;
  RESET ROLE;

  -- Staff still read through their door under the revoke.
  PERFORM pg_temp.as_client(c_staff);
  SET LOCAL ROLE authenticated;
  SELECT s.city INTO v_t FROM public.get_full_profiles_for_staff(ARRAY[c_u2]) s;
  IF v_t IS DISTINCT FROM 'Rehearsal City' THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: staff door after the revoke: %', v_t;
  END IF;
  RESET ROLE;
  v_report := v_report || ' revoke=stranger-refused,public-read,owner-door,owner-edit,upsert-refused,presence,readers-ok,staff-door';

  RAISE EXCEPTION 'REHEARSAL OK:% in % ms', v_report,
    round(extract(epoch FROM clock_timestamp() - v_t0) * 1000);
END $r$;
