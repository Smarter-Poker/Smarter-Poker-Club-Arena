-- ============================================================================
-- REHEARSAL (rolled back; run by rehearse.sh after migration 20260930234500):
-- the revoke as a stranger, the owner, staff and a visitor meet it. Fixture
-- accounts only (fn_ca_is_fixture_account); nothing persists. Ends in a
-- deliberate error: REHEARSAL OK is the success line.
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
  v_refused integer := 0;
  v_j jsonb;
  v_t text;
  v_c text;
  v_club uuid;
  v_story uuid;
  v_report text := '';
  v_t0 timestamptz := clock_timestamp();
BEGIN
  IF NOT (public.fn_ca_is_fixture_account(c_staff) AND public.fn_ca_is_fixture_account(c_u1)
          AND public.fn_ca_is_fixture_account(c_u2)) THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: a rehearsal identity is not a fixture account';
  END IF;
  UPDATE public.profiles SET role = 'admin' WHERE id = c_staff;
  UPDATE public.profiles SET full_name = 'Rehearsal Person Two', city = 'Rehearsal City', state = 'RS',
         country = 'RC', birth_year = 1990, is_online = true, last_seen = now() WHERE id = c_u2;
  UPDATE public.profiles SET full_name = 'Rehearsal Person One', city = 'Own City' WHERE id = c_u1;
  SELECT m.club_id INTO v_club FROM public.club_members m GROUP BY m.club_id ORDER BY count(*) DESC LIMIT 1;
  INSERT INTO public.social_stories (author_id, content, expires_at)
       VALUES (c_u2, 'rehearsal story', now() + interval '1 hour') RETURNING id INTO v_story;
  INSERT INTO public.social_follows (follower_id, following_id) VALUES (c_u1, c_u2);
  SELECT * INTO v_u1 FROM public.profiles WHERE id = c_u1;
  SELECT * INTO v_u2 FROM public.profiles WHERE id = c_u2;

  -- 1. A stranger is refused every private column, one statement each.
  PERFORM pg_temp.as_client(c_u1);
  SET LOCAL ROLE authenticated;
  FOREACH v_c IN ARRAY v_private LOOP
    BEGIN
      EXECUTE format('SELECT %I FROM public.profiles WHERE id = $1', v_c) USING c_u2;
      RAISE EXCEPTION 'REHEARSAL FAIL: a stranger read %', v_c;
    EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1;
    END;
  END LOOP;
  IF v_refused <> 17 THEN RAISE EXCEPTION 'REHEARSAL FAIL: % of 17 refused', v_refused; END IF;
  -- ...and the owner too, from the table: column grants are not per row.
  BEGIN
    PERFORM p.diamonds FROM public.profiles p WHERE p.id = c_u1;
    RAISE EXCEPTION 'REHEARSAL FAIL: the table answered an owner''s own balance';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- What the table needs still reads (the Club Arena's name list and the seat embed shape).
  SELECT count(*) INTO v_n FROM public.profiles p
   WHERE p.id = ANY (ARRAY[c_u1, c_u2])
     AND p.username IS NOT DISTINCT FROM (CASE WHEN p.id = c_u1 THEN v_u1.username ELSE v_u2.username END);
  IF v_n <> 2 THEN RAISE EXCEPTION 'REHEARSAL FAIL: the name list read % rows', v_n; END IF;
  SELECT count(*) INTO v_n FROM (
    SELECT p.username, p.display_name, p.alias, p.display_name_preference, p.use_real_name,
           p.arena_avatar_url AS avatar_url, p.player_number, p.level, p.is_vip, p.vip_tier, p.vip_expires_at,
           p.bio, p.player_tags, p.login_streak, p.created_at, p.is_online, p.role, p.equipped_frame, p.equipped_aura
      FROM public.profiles p WHERE p.id = c_u2) x;
  IF v_n <> 1 THEN RAISE EXCEPTION 'REHEARSAL FAIL: the public columns did not read'; END IF;
  v_report := v_report || ' stranger=refused(17/17),owner-table=refused public=reads';

  -- 2. The owner reads their own private fields through the door, and edits them.
  SELECT g.id, g.diamonds, g.full_name, g.city, g.last_seen, g.updated_at INTO v_row
    FROM public.get_my_full_profile() g WHERE g.id = c_u1;
  IF v_row.id IS DISTINCT FROM c_u1 OR v_row.diamonds IS DISTINCT FROM v_u1.diamonds
     OR v_row.full_name IS DISTINCT FROM 'Rehearsal Person One' OR v_row.city IS DISTINCT FROM 'Own City' THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: owner door %', v_row;
  END IF;
  SELECT count(*) INTO v_n FROM public.get_my_full_profile() g WHERE g.id = c_u2;
  IF v_n <> 0 THEN RAISE EXCEPTION 'REHEARSAL FAIL: the owner door answered another account'; END IF;
  UPDATE public.profiles SET city = 'Edited City', full_name = 'Edited Name' WHERE id = c_u1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'REHEARSAL FAIL: the owner could not edit their row'; END IF;
  v_report := v_report || ' owner=door,edit';

  -- 3. Presence and the moved readers.
  IF NOT (SELECT x.is_online FROM public.fn_profile_presence(ARRAY[c_u2]) x) THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: presence';
  END IF;
  v_j := to_jsonb(public.get_top_mission_completers(v_club, 3));
  v_j := public.fn_get_stories(c_u1);
  SELECT e->>'author_fullname' INTO v_t FROM jsonb_array_elements(v_j) e WHERE (e->>'id')::uuid = v_story;
  IF v_t IS DISTINCT FROM COALESCE(v_u2.display_name, v_u2.username) THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: story author %', v_t;
  END IF;
  v_j := public.get_unified_user_profile(c_u2);
  IF (v_j->'profile'->>'city') IS NOT NULL OR (v_j->'profile'->>'full_name') IS NOT NULL THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: unified profile %', v_j->'profile';
  END IF;
  SELECT count(*) INTO v_n FROM public.get_visible_live_streams() ls WHERE ls.broadcaster_full_name IS NOT NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'REHEARSAL FAIL: % live streams still name a broadcaster', v_n; END IF;
  IF v_t IS NOT DISTINCT FROM v_u2.full_name THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: the story bar named its author by legal name';
  END IF;
  v_report := v_report || ' presence,stories,missions,unified,live-streams=ok';

  -- 3b. The five invoker functions whose text names a private column (privacy-wh's list) keep
  -- working after the revoke and tell a stranger nothing private.
  -- fn_update_presence: the owner's heartbeat still writes (UPDATE stays granted; it filters on id).
  PERFORM public.fn_update_presence(c_u1, true);
  SELECT g.is_online, g.last_seen INTO v_row FROM public.get_my_full_profile() g WHERE g.id = c_u1;
  IF v_row.is_online IS DISTINCT FROM true OR v_row.last_seen IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: the presence heartbeat %', v_row;
  END IF;
  -- fn_ca_diamond_transfer_names_its_counterparty: a trigger on diamond_transactions, which no
  -- browser role may write, so it runs only under a definer or the service role; and the one
  -- profile fact it reads, that the counterparty's id exists, is public even to a browser role.
  IF has_table_privilege('authenticated', 'public.diamond_transactions', 'INSERT')
     OR has_table_privilege('anon', 'public.diamond_transactions', 'INSERT') THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: a browser role may write diamond_transactions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = c_u2) THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: the counterparty check cannot see an account';
  END IF;
  -- fn_hg_caller_display_name: called directly by a stranger it is refused (it reads the
  -- real-name columns as its caller), so it cannot hand one out...
  BEGIN
    v_t := public.fn_hg_caller_display_name(c_u2);
    RAISE EXCEPTION 'REHEARSAL FAIL: a stranger called fn_hg_caller_display_name and got %', v_t;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;
  -- ...its five callers (the home-game roster, seat claim, table list, start and unseat notice)
  -- are definers whose owner still reads profiles, so they keep working...
  SELECT string_agg(p.oid::regprocedure::text, ', '), count(*) INTO v_t, v_n FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ~ 'fn_hg_caller_display_name'
     AND p.proname <> 'fn_hg_caller_display_name'
     AND NOT (p.prosecdef AND has_column_privilege(p.proowner, 'public.profiles', 'full_name', 'SELECT'));
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: a caller of fn_hg_caller_display_name runs as its caller: %', v_t;
  END IF;
  -- ...and, run as that owner, it answers the arena name and never the legal name.
  v_t := public.fn_hg_caller_display_name(c_u2);
  IF v_t IS DISTINCT FROM public.fn_arena_name(v_u2.alias, v_u2.username, v_u2.display_name,
                                               v_u2.first_name, v_u2.last_name, v_u2.full_name)
     OR v_t IS NOT DISTINCT FROM v_u2.full_name THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: the home-game name %', v_t;
  END IF;
  v_report := v_report || ' heartbeat,transfer-check,hg-name=arena-only(direct-refused)';

  -- 4. Staff read through their door; a player cannot.
  PERFORM pg_temp.as_client(c_staff);
  SET LOCAL ROLE authenticated;
  SELECT s.full_name, s.city, s.birth_year INTO v_row FROM public.get_full_profiles_for_staff(ARRAY[c_u2]) s;
  IF v_row.full_name IS DISTINCT FROM 'Rehearsal Person Two' OR v_row.city IS DISTINCT FROM 'Rehearsal City' THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: staff door %', v_row;
  END IF;
  RESET ROLE;
  PERFORM pg_temp.as_client(c_u1);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM 1 FROM public.get_full_profiles_for_staff(ARRAY[c_u2]);
    RAISE EXCEPTION 'REHEARSAL FAIL: a player read the staff door';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;
  v_report := v_report || ' staff=reads,player-refused';

  -- 5. A visitor: no profile row (no policy), the signed-out profile page without a name or balance.
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  -- A visitor holds SELECT on bio and player_tags only, and no policy, as before.
  SELECT count(*) INTO v_n FROM (SELECT p.bio, p.player_tags FROM public.profiles p) x;
  IF v_n <> 0 THEN RAISE EXCEPTION 'REHEARSAL FAIL: a visitor read % profile rows', v_n; END IF;
  BEGIN
    PERFORM p.full_name FROM public.profiles p WHERE p.id = c_u2;
    RAISE EXCEPTION 'REHEARSAL FAIL: a visitor read full_name';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SELECT * INTO v_row FROM public.get_public_profile_by_username(v_u2.username);
  IF v_row.username IS DISTINCT FROM v_u2.username OR v_row.full_name IS NOT NULL OR v_row.diamonds IS NOT NULL THEN
    RAISE EXCEPTION 'REHEARSAL FAIL: public profile %', v_row;
  END IF;
  RESET ROLE;
  v_report := v_report || ' visitor=no-row,public-page-no-name';

  RAISE EXCEPTION 'REHEARSAL OK:% in % ms', v_report,
    round(extract(epoch FROM clock_timestamp() - v_t0) * 1000);
END $r$;
