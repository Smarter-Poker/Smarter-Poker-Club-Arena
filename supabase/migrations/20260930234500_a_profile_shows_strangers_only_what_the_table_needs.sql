-- 20260930234500_a_profile_shows_strangers_only_what_the_table_needs
--
-- Diamond Arena Phase 10, line 2 (public and private fields), step 2 of 2.
-- Applied once to kuklfnapbkmacvwxktbh, after step 1
-- (20260930234000_a_profiles_private_fields_have_an_owner_and_a_staff_door)
-- and after the Club Arena and the World Hub stopped naming a private column.
--
-- Never apply between :50 and :03 of any hour (CLAUDE.md section 2 rule 8).
-- One transaction, as required by the same rule.
--
-- ═══ THE DECISION ═════════════════════════════════════════════════════════
--
-- Ruling 25 (docs/DIAMOND-RULINGS.md), decided by Claude on Dan's delegation
-- of 2026-09-30 ("these are all for you to decide not me ... FIX AND FINISH
-- ALL OF THESE"): a stranger sees only what playing with you needs - display
-- name, username, avatar, player number and public statistics. Anything that
-- reveals a person's money, real identity or whereabouts is readable only by
-- that person and by platform staff.
--
-- ═══ WHAT THIS DOES ═══════════════════════════════════════════════════════
--
-- 1. Refuses to run while any reader a browser can reach still names a
--    private column of profiles: an invoker function a signed-in or signed-out
--    caller can execute, or one fired by a trigger on a table they can write,
--    an RLS policy, or a view they can read. The only names allowed through
--    are the six reviewed in step 1, which read nothing private (a word in a
--    comment, NEW/OLD fields, a write) or run only under a definer.
-- 2. Revokes SELECT on the seventeen private columns from authenticated and
--    anon. Column grants are not per row, so the owner reads their own row
--    through get_my_full_profile(), staff through
--    get_full_profiles_for_staff(uuid[]), and presence through
--    fn_profile_presence(uuid[]). UPDATE and INSERT are untouched (the owner
--    still edits their own row), RLS is untouched, service_role is untouched.
-- 3. Corrects the two new doors' database comments to ruling 25 (step 1 named
--    it 22, the number it was written under before rulings 22 to 24 landed).
-- 4. Closes one more definer door the revoke cannot reach:
--    get_visible_live_streams() answered every signed-in caller with each live
--    broadcaster's legal name (broadcaster_full_name). Same signature; that
--    column is now NULL, and the World Hub stopped reading it in #2056. By
--    asserted substitution, live md5 pinned, the reverse proved, grants kept.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)), read 2026-10-01:
--   get_visible_live_streams()   01efdcda8c294e68635d9ceaa33eabce
--   get_my_full_profile()        a464244a590dd2615cadc79c63a283ba
--
-- GRANT and REVOKE of column privileges take no lock on the table
-- (PostgreSQL 17, measured), so this cannot queue behind live traffic.
-- Nothing is written, no Diamond moves, no switch is touched.
--
-- It creates no object, so it states its own proof:
-- @live-proof: (SELECT bool_and(NOT has_column_privilege('authenticated', 'public.profiles', c, 'SELECT') AND NOT has_column_privilege('anon', 'public.profiles', c, 'SELECT')) FROM unnest(ARRAY['diamonds','diamond_balance','diamond_multiplier','first_name','last_name','full_name','birth_year','city','state','country','last_seen','last_login','last_login_date','last_active','updated_at','referred_by','poker_near_me_preferences']) AS c)
-- @live-proof: (SELECT bool_and(has_column_privilege('authenticated', 'public.profiles', c, 'SELECT')) FROM unnest(ARRAY['id','username','display_name','alias','avatar_url','arena_avatar_url','player_number','level','is_online','created_at']) AS c)
-- @live-proof: (SELECT has_column_privilege('authenticated', 'public.profiles', 'full_name', 'UPDATE') AND has_column_privilege('authenticated', 'public.profiles', 'city', 'UPDATE'))
-- @live-proof: (SELECT position('p.username, NULL::text, p.avatar_url' in p.prosrc) > 0 FROM pg_proc p WHERE p.oid = 'public.get_visible_live_streams()'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. EVERY READER HAS MOVED
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_private constant text[] := ARRAY['diamonds','diamond_balance','diamond_multiplier','first_name',
    'last_name','full_name','birth_year','city','state','country','last_seen','last_login',
    'last_login_date','last_active','updated_at','referred_by','poker_near_me_preferences'];
  v_reviewed constant text[] := ARRAY[
    'fn_ca_diamond_transfer_names_its_counterparty()',   -- reads p.id only
    'fn_calculate_rakeback(uuid,timestamp with time zone,timestamp with time zone)', -- a stub
    'fn_guard_profile_privileged_columns()',              -- NEW/OLD only
    'fn_protect_profile_username_and_gate()',             -- NEW/OLD; reads username, id
    'fn_update_presence(uuid,boolean)',                   -- writes; filters on id
    'fn_hg_caller_display_name(uuid)'];                   -- called by definers only
  v_bad text;
BEGIN
  WITH browser_tables AS (
    SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
       AND (has_table_privilege('authenticated', c.oid, 'INSERT') OR has_table_privilege('authenticated', c.oid, 'UPDATE')
         OR has_table_privilege('authenticated', c.oid, 'DELETE') OR has_table_privilege('anon', c.oid, 'INSERT')
         OR has_table_privilege('anon', c.oid, 'UPDATE') OR has_table_privilege('anon', c.oid, 'DELETE'))
  ), reach AS (
    SELECT p.oid FROM pg_proc p
     WHERE NOT p.prosecdef AND p.prokind IN ('f','p')
       AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))
    UNION
    SELECT t.tgfoid FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal AND NOT p.prosecdef AND t.tgrelid IN (SELECT oid FROM browser_tables)
  )
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM reach r JOIN pg_proc p ON p.oid = r.oid JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog','information_schema','extensions','graphql','graphql_public','pgsodium',
                           'vault','realtime','storage','supabase_functions','net','cron','pgbouncer','auth')
     AND p.prosrc ~* '\mprofiles\M'
     AND EXISTS (SELECT 1 FROM unnest(v_private) c WHERE p.prosrc ~* ('\m' || c || '\M'))
     AND NOT (p.oid::regprocedure::text = ANY (v_reviewed));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'a reader a browser can reach still names a private profile column: %', v_bad;
  END IF;

  SELECT string_agg(c.relname || '.' || po.polname, ', ') INTO v_bad
    FROM pg_policy po JOIN pg_class c ON c.oid = po.polrelid
   WHERE coalesce(pg_get_expr(po.polqual, po.polrelid), '') || coalesce(pg_get_expr(po.polwithcheck, po.polrelid), '')
         ~* '\mprofiles\M'
     AND EXISTS (SELECT 1 FROM unnest(v_private) x
                  WHERE coalesce(pg_get_expr(po.polqual, po.polrelid), '') || coalesce(pg_get_expr(po.polwithcheck, po.polrelid), '')
                        ~* ('\m' || x || '\M'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'a policy reads a private profile column: %', v_bad;
  END IF;

  SELECT string_agg(v.oid::regclass::text, ', ') INTO v_bad
    FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class v ON v.oid = r.ev_class
   WHERE d.refobjid = 'public.profiles'::regclass AND v.oid <> 'public.profiles'::regclass
     AND (has_table_privilege('authenticated', v.oid, 'SELECT') OR has_table_privilege('anon', v.oid, 'SELECT'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'a browser-readable view reads profiles: %', v_bad;
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 2. THE REVOKE
-- ---------------------------------------------------------------------------
REVOKE SELECT (diamonds, diamond_balance, diamond_multiplier, first_name, last_name, full_name,
               birth_year, city, state, country, last_seen, last_login, last_login_date, last_active,
               updated_at, referred_by, poker_near_me_preferences)
  ON public.profiles FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- 3. THE DOORS NAME THEIR RULING
-- ---------------------------------------------------------------------------
COMMENT ON FUNCTION public.get_full_profiles_for_staff(uuid[]) IS
  'The staff door to profiles: the whole row of each account asked for, to platform staff only (fn_is_platform_admin), 42501 for anyone else. The owner door is get_my_full_profile(). Ruling 25 (docs/DIAMOND-RULINGS.md), migrations 20260930234000 and 20260930234500.';
COMMENT ON FUNCTION public.fn_profile_presence(uuid[]) IS
  'Who of the accounts asked for is online now: is_online counted only while last_seen is under five minutes old (the friends list and ca_club_member_downline rule). Never returns last_seen, which is its owner''s. Ruling 25 (docs/DIAMOND-RULINGS.md), migrations 20260930234000 and 20260930234500.';

-- ---------------------------------------------------------------------------
-- 4. THE LIVE-STREAM LIST STOPS NAMING A BROADCASTER BY THEIR LEGAL NAME
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid := to_regprocedure('public.get_visible_live_streams()');
  v_def text;
  v_acl text;
  v_n integer;
  v_old constant text := 'p.username, p.full_name, p.avatar_url';
  v_new constant text := 'p.username, NULL::text, p.avatar_url';
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'get_visible_live_streams() is missing';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '01efdcda8c294e68635d9ceaa33eabce' THEN
    RAISE EXCEPTION 'get_visible_live_streams is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'get_visible_live_streams: the broadcaster columns occur % times, expected 1', v_n;
  END IF;
  SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = v_oid;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '01efdcda8c294e68635d9ceaa33eabce' THEN
    RAISE EXCEPTION 'get_visible_live_streams: the reverse substitution does not reproduce the pinned text';
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM v_acl THEN
    RAISE EXCEPTION 'get_visible_live_streams: the grants changed';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 5. THE ESTATE IS AS IT WAS, AND THE TABLE SAYS ONLY WHAT IT SHOULD
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_private constant text[] := ARRAY['diamonds','diamond_balance','diamond_multiplier','first_name',
    'last_name','full_name','birth_year','city','state','country','last_seen','last_login',
    'last_login_date','last_active','updated_at','referred_by','poker_near_me_preferences'];
  v_n integer;
  v_bad text;
BEGIN
  SELECT string_agg(c, ', ') INTO v_bad FROM unnest(v_private) c
   WHERE has_column_privilege('authenticated', 'public.profiles', c, 'SELECT')
      OR has_column_privilege('anon', 'public.profiles', c, 'SELECT');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'still readable by a browser: %', v_bad;
  END IF;
  -- The public columns: the 98 authenticated read before, less the 17.
  SELECT count(*) INTO v_n FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND table_name = 'profiles' AND grantee = 'authenticated' AND privilege_type = 'SELECT';
  IF v_n <> 81 THEN
    RAISE EXCEPTION 'authenticated reads % columns of profiles, expected 81', v_n;
  END IF;
  IF NOT (SELECT bool_and(has_column_privilege('authenticated', 'public.profiles', c, 'SELECT'))
            FROM unnest(ARRAY['id','username','display_name','alias','avatar_url','arena_avatar_url',
                              'player_number','level','is_online','created_at','bio','player_tags']) c) THEN
    RAISE EXCEPTION 'a public column stopped being readable';
  END IF;
  -- Writes, the service role and RLS are as they were.
  SELECT count(*) INTO v_n FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND table_name = 'profiles' AND grantee = 'authenticated' AND privilege_type = 'UPDATE';
  IF v_n <> 99 THEN
    RAISE EXCEPTION 'authenticated may update % columns of profiles, expected 99', v_n;
  END IF;
  IF NOT has_table_privilege('service_role', 'public.profiles', 'SELECT')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.profiles'::regclass)
     OR (SELECT string_agg(polname, ',' ORDER BY polname) FROM pg_policy WHERE polrelid = 'public.profiles'::regclass)
        IS DISTINCT FROM 'profiles_delete,profiles_insert_self,profiles_select,profiles_update' THEN
    RAISE EXCEPTION 'the service role or the row policies of profiles changed';
  END IF;
  -- The three doors.
  IF md5(pg_get_functiondef('public.get_my_full_profile()'::regprocedure)) <> 'a464244a590dd2615cadc79c63a283ba'
     OR has_function_privilege('anon', 'public.get_my_full_profile()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_my_full_profile()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_full_profiles_for_staff(uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_full_profiles_for_staff(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_profile_presence(uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_profile_presence(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'a profile door is not as step 1 left it';
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
  RAISE NOTICE 'a profile shows strangers only what the table needs: 17 columns are their owner''s and staff''s, 81 stay public';
END $m$;

COMMIT;
