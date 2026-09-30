-- 20260930234000_a_profiles_private_fields_have_an_owner_and_a_staff_door
--
-- Diamond Arena Phase 10, line 2 (public and private fields), step 1 of 2.
-- Applied once to kuklfnapbkmacvwxktbh. Step 2, the column revoke, is
-- 20260930234500_a_profile_shows_strangers_only_what_the_table_needs and is
-- applied only after every reader has moved.
--
-- Never apply between :50 and :03 of any hour (CLAUDE.md section 2 rule 8).
-- One transaction, as required by the same rule.
--
-- ═══ THE DECISION ═════════════════════════════════════════════════════════
--
-- Dan, 2026-09-30: "these are all for you to decide not me ... FIX AND
-- FINISH ALL OF THESE". Decided by Claude on Dan's delegation of 2026-09-30
-- (docs/DIAMOND-RULINGS.md, ruling 22): a stranger sees only what playing
-- with you needs - display name, username, avatar, player number and public
-- statistics. Anything that reveals a person's money, real identity or
-- whereabouts is readable only by that person and by platform staff.
--
-- ═══ WHAT THIS DOES ═══════════════════════════════════════════════════════
--
-- 1. THE STAFF DOOR, new: get_full_profiles_for_staff(uuid[]) returns the
--    whole profile row of the accounts asked for, to platform staff only
--    (fn_is_platform_admin(): role admin, superadmin or god). Anyone else,
--    signed in or not, is refused by name (42501). A definer read; signed-in
--    accounts and the service role may call it, a visitor may not.
-- 2. THE OWNER DOOR already exists and is kept as it is: get_my_full_profile()
--    returns the caller's own row and nothing else, and refuses a caller with
--    no account. The World Hub's profile editor and the birthday revoke of
--    2026-09-29 already read the owner's private fields through it. It is
--    pinned here so the revoke cannot land on a changed door.
-- 3. SEVEN READERS THAT NAMED A STRANGER BY THEIR LEGAL NAME, AND TWO PROFILE
--    DOORS THAT ANSWERED WITH ONE, stop reading private fields. Each changes
--    by asserted substitution (live md5 pinned, the old clause found exactly
--    once, the reverse proved), keeps its grants, and is otherwise untouched:
--      fn_get_stories                 the story bar's author name
--      get_top_mission_completers     a club's mission leaders
--      fn_notify_home_member_status   \
--      fn_notify_home_post_comment     |
--      fn_notify_home_post_created     |  the name a notification prints
--      fn_notify_home_post_like        |  about the person who acted
--      fn_notify_home_rsvp             |
--      fn_welcome_new_approved_member  |
--      fn_notify_mention              /
--      get_public_profile_by_username the signed-out profile page: no legal
--                                     name and no Diamond balance
--      get_unified_user_profile       city and state for the owner only (the
--                                     legal name and balance already were)
--    The first two and the notification triggers are SECURITY INVOKER: once
--    step 2 revokes the columns, a browser call that names one is refused
--    whole, and fn_get_stories would swallow that refusal and show an empty
--    story bar. The two profile doors are definers the revoke cannot reach,
--    so they are closed here directly.
--
-- Nothing is revoked here and nothing a client reads today changes shape:
-- every edited function keeps its signature, its result columns and its
-- grants. No Diamond moves, no switch is touched, and no edited function is
-- on fn_ca_guard_watchlist().
--
-- PINNED LIVE md5(pg_get_functiondef(oid)), read 2026-09-30:
--   get_my_full_profile()                     a464244a590dd2615cadc79c63a283ba
--   fn_get_stories(uuid)                      fc722ae39f052e2d2f3c373256877375
--   get_top_mission_completers(uuid,integer)  be4dae914d9677fe4d14e2817840c267
--   fn_notify_home_member_status()            3534e6d372b42f836c4116c506d9c3d1
--   fn_notify_home_post_comment()             d14f2ccabce86272881173c029df720e
--   fn_notify_home_post_created()             1fdad227e6c806fb657efa131cc01a70
--   fn_notify_home_post_like()                b3268c70394e740f63b105bddf7e69f4
--   fn_notify_home_rsvp()                     4f4e631373f4ba26e295ffaf8560cb86
--   fn_welcome_new_approved_member()          3501f4b3fa7f5d98d70b834089d02427
--   fn_notify_mention()                       cd059227571de74328acef69e29e75ab
--   get_public_profile_by_username(text)      c92d550a49ee4c12c58120a25bc20745
--   get_unified_user_profile(uuid)            a5dcf9ad960a54892fba42a9eb0f8584
--
-- The substitutions run through EXECUTE, which the liveness check cannot see,
-- so they state their own proof:
-- @live-proof: (SELECT position('COALESCE(p.display_name, p.username) AS author_fullname' in p.prosrc) > 0 FROM pg_proc p WHERE p.oid = 'public.fn_get_stories(uuid)'::regprocedure)
-- @live-proof: (SELECT position('public.fn_arena_name(p.alias, p.username, p.display_name, NULL, NULL, NULL)' in p.prosrc) > 0 FROM pg_proc p WHERE p.oid = 'public.get_top_mission_completers(uuid,integer)'::regprocedure)
-- @live-proof: (SELECT position('full_name' in p.prosrc) = 0 FROM pg_proc p WHERE p.oid = 'public.fn_notify_mention()'::regprocedure)
-- @live-proof: (SELECT position('p.full_name' in p.prosrc) = 0 AND position('p.diamonds' in p.prosrc) = 0 FROM pg_proc p WHERE p.oid = 'public.get_public_profile_by_username(text)'::regprocedure)
-- @live-proof: (SELECT position('''city'', CASE WHEN v_is_self THEN v_profile.city ELSE NULL END' in p.prosrc) > 0 FROM pg_proc p WHERE p.oid = 'public.get_unified_user_profile(uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. THE STAFF DOOR
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.get_full_profiles_for_staff(p_user_ids uuid[])
RETURNS SETOF public.profiles
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- A profile's private fields (money, real identity, whereabouts) are read
  -- by their owner, through get_my_full_profile(), and by platform staff,
  -- through this door. Nobody else.
  IF auth.uid() IS NULL OR NOT COALESCE(public.fn_is_platform_admin(), false) THEN
    RAISE EXCEPTION 'a profile''s private fields are read only by its owner and by platform staff'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT p.*
      FROM public.profiles p
     WHERE p.id = ANY (COALESCE(p_user_ids, ARRAY[]::uuid[]));
END
$fn$;

COMMENT ON FUNCTION public.get_full_profiles_for_staff(uuid[]) IS
  'The staff door to profiles: the whole row of each account asked for, to platform staff only (fn_is_platform_admin), 42501 for anyone else. The owner door is get_my_full_profile(). Ruling 22 (docs/DIAMOND-RULINGS.md), migration 20260930234000_a_profiles_private_fields_have_an_owner_and_a_staff_door.';

REVOKE ALL ON FUNCTION public.get_full_profiles_for_staff(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_full_profiles_for_staff(uuid[]) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. READERS THAT NAME A STRANGER STOP READING PRIVATE FIELDS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  r record;
  v_oid oid;
  v_def text;
  v_acl text;
  v_n integer;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.fn_get_stories(uuid)', 'fc722ae39f052e2d2f3c373256877375',
       $o$COALESCE(p.full_name, p.username) AS author_fullname$o$,
       $n$COALESCE(p.display_name, p.username) AS author_fullname$n$),
      ('public.get_top_mission_completers(uuid,integer)', 'be4dae914d9677fe4d14e2817840c267',
       $o$public.fn_arena_name(p.alias, p.username, p.display_name, p.first_name, p.last_name, p.full_name)$o$,
       $n$public.fn_arena_name(p.alias, p.username, p.display_name, NULL, NULL, NULL)$n$),
      ('public.fn_notify_home_member_status()', '3534e6d372b42f836c4116c506d9c3d1',
       $o$COALESCE(display_name, full_name, username, 'New member')$o$,
       $n$COALESCE(display_name, username, 'New member')$n$),
      ('public.fn_notify_home_post_comment()', 'd14f2ccabce86272881173c029df720e',
       $o$COALESCE(display_name, full_name, username, 'Someone')$o$,
       $n$COALESCE(display_name, username, 'Someone')$n$),
      ('public.fn_notify_home_post_created()', '1fdad227e6c806fb657efa131cc01a70',
       $o$COALESCE(display_name, full_name, username, 'A host')$o$,
       $n$COALESCE(display_name, username, 'A host')$n$),
      ('public.fn_notify_home_post_like()', 'b3268c70394e740f63b105bddf7e69f4',
       $o$COALESCE(display_name, full_name, username, 'Someone')$o$,
       $n$COALESCE(display_name, username, 'Someone')$n$),
      ('public.fn_notify_home_rsvp()', '4f4e631373f4ba26e295ffaf8560cb86',
       $o$COALESCE(p.display_name, p.full_name, p.username, 'Someone')$o$,
       $n$COALESCE(p.display_name, p.username, 'Someone')$n$),
      ('public.fn_welcome_new_approved_member()', '3501f4b3fa7f5d98d70b834089d02427',
       $o$COALESCE(display_name, full_name, username, 'a new member')$o$,
       $n$COALESCE(display_name, username, 'a new member')$n$),
      ('public.fn_notify_mention()', 'cd059227571de74328acef69e29e75ab',
       $o$COALESCE(full_name, username, 'Someone')$o$,
       $n$COALESCE(display_name, username, 'Someone')$n$),
      ('public.get_public_profile_by_username(text)', 'c92d550a49ee4c12c58120a25bc20745',
       $o$p.id, p.username, p.full_name, p.display_name, p.bio, p.avatar_url,
    p.level, p.diamonds, p.created_at$o$,
       $n$p.id, p.username, NULL::text, p.display_name, p.bio, p.avatar_url,
    p.level, NULL::integer, p.created_at$n$),
      ('public.get_unified_user_profile(uuid)', 'a5dcf9ad960a54892fba42a9eb0f8584',
       $o$'city', v_profile.city, 'state', v_profile.state,$o$,
       $n$'city', CASE WHEN v_is_self THEN v_profile.city ELSE NULL END, 'state', CASE WHEN v_is_self THEN v_profile.state ELSE NULL END,$n$)
    ) AS s(sig, pin, old_text, new_text)
  LOOP
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION '% is missing', r.sig;
    END IF;
    v_def := pg_get_functiondef(v_oid);
    IF md5(v_def) <> r.pin THEN
      RAISE EXCEPTION '% is not the pinned text (md5 %)', r.sig, md5(v_def);
    END IF;
    v_n := (length(v_def) - length(replace(v_def, r.old_text, ''))) / length(r.old_text);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: the clause to replace occurs % times, expected 1', r.sig, v_n;
    END IF;
    IF position(r.new_text in v_def) > 0 THEN
      RAISE EXCEPTION '%: the replacement is already present', r.sig;
    END IF;
    SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = v_oid;
    EXECUTE replace(v_def, r.old_text, r.new_text);
    IF md5(replace(pg_get_functiondef(v_oid), r.new_text, r.old_text)) <> r.pin THEN
      RAISE EXCEPTION '%: the reverse substitution does not reproduce the pinned text', r.sig;
    END IF;
    IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM v_acl THEN
      RAISE EXCEPTION '%: the grants changed', r.sig;
    END IF;
  END LOOP;
END $m$;

-- ---------------------------------------------------------------------------
-- 3. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_staff oid := to_regprocedure('public.get_full_profiles_for_staff(uuid[])');
  v_owner oid := to_regprocedure('public.get_my_full_profile()');
  v_bad text;
BEGIN
  -- The staff door: one definer, returning profile rows, a signed-in account
  -- or the service role may call it, a visitor may not, and PUBLIC holds no
  -- grant.
  IF v_staff IS NULL
     OR (SELECT count(*) FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace
            AND proname = 'get_full_profiles_for_staff') <> 1 THEN
    RAISE EXCEPTION 'get_full_profiles_for_staff(uuid[]) must exist exactly once';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_staff)
     OR (SELECT prorettype FROM pg_proc WHERE oid = v_staff) <> 'public.profiles'::regtype
     OR NOT (SELECT proretset FROM pg_proc WHERE oid = v_staff)
     OR has_function_privilege('anon', v_staff, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_staff, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_staff, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid = v_staff AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'the staff door must be a definer returning profile rows that a signed-in account may call and a visitor may not';
  END IF;

  -- The owner door is the pinned text: the caller's own row, a caller with no
  -- account refused, and a visitor cannot call it at all.
  IF v_owner IS NULL
     OR md5(pg_get_functiondef(v_owner)) <> 'a464244a590dd2615cadc79c63a283ba'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_owner)
     OR has_function_privilege('anon', v_owner, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_owner, 'EXECUTE') THEN
    RAISE EXCEPTION 'get_my_full_profile() is not the pinned owner door';
  END IF;

  -- No edited reader still names a private field of the person it describes.
  SELECT string_agg(x.sig, ', ') INTO v_bad
    FROM (VALUES
      ('public.fn_get_stories(uuid)', '\mfull_name\M'),
      ('public.get_top_mission_completers(uuid,integer)', '\m(first_name|last_name|full_name)\M'),
      ('public.fn_notify_home_member_status()', '\mfull_name\M'),
      ('public.fn_notify_home_post_comment()', '\mfull_name\M'),
      ('public.fn_notify_home_post_created()', '\mfull_name\M'),
      ('public.fn_notify_home_post_like()', '\mfull_name\M'),
      ('public.fn_notify_home_rsvp()', '\mfull_name\M'),
      ('public.fn_welcome_new_approved_member()', '\mfull_name\M'),
      ('public.fn_notify_mention()', '\mfull_name\M'),
      ('public.get_public_profile_by_username(text)', '\mp\.(full_name|diamonds)\M')
    ) AS x(sig, pattern)
   WHERE pg_get_functiondef(to_regprocedure(x.sig)) ~ x.pattern;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'readers still naming a private field: %', v_bad;
  END IF;
  IF (length(pg_get_functiondef('public.get_unified_user_profile(uuid)'::regprocedure))
      - length(replace(pg_get_functiondef('public.get_unified_user_profile(uuid)'::regprocedure),
                       'CASE WHEN v_is_self THEN v_profile.', ''))) / length('CASE WHEN v_is_self THEN v_profile.') <> 6 THEN
    RAISE EXCEPTION 'get_unified_user_profile must gate exactly its six owner-only fields on v_is_self';
  END IF;

  -- The Diamond estate is untouched.
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open a Diamond switch';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'a profile''s private fields have an owner door and a staff door; eleven readers moved off them';
END $m$;

COMMIT;
