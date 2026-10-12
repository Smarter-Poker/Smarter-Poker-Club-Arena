-- 20261001125101_platform_staff_open_commander.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ============================================================================
-- PLATFORM STAFF OPEN COMMANDER
-- ============================================================================
--
-- A follow-up to Ruling 22 ("the Diamond Arena belongs to the system", decided
-- by Claude on Dan's delegation of 2026-09-30, migration 20260930235500).
-- Recorded under Ruling 22 in docs/DIAMOND-RULINGS.md and in
-- docs/evidence/diamond-phase-11/the-arena-belongs-to-the-system.md.
--
-- WHAT WENT MISSING. The World Hub decides whether an account has Club Commander
-- access with get_commander_access_details (pages/api/check-access.js: the
-- Commander orb in the carousel, and "Host A Home Game" going straight to
-- home-game creation). Profile summaries use has_commander_access. Both knew
-- four ways in: owning a club, a Commander subscription, an owner or manager
-- row at a venue, or owning a home group. daniel@smarter.poker, the god admin
-- account Dan and the scripts use, had only the first, and only because it
-- owned the Diamond Arena. Ruling 22 gave the arena to the system account, and
-- that account's Commander access went with it.
--
-- THE SANCTIONED WAY BACK. Commander already has a staff rule, and it is the
-- platform's: fn_is_platform_admin(), which admits the roles admin, superadmin
-- and god. It already gates the Commander activity log, leads, onboarding
-- leads, rate limits, system log, tournament points and templates, and player
-- reputation. Both access functions now admit platform staff by that same rule.
-- No venue row is made up, no subscription is invented, and no club, least of
-- all the arena, gets an owner back.
--
-- The rule is read for the user being asked about. The World Hub asks as the
-- server, on behalf of the token's user, so auth.uid() is empty there and
-- fn_is_platform_admin() itself would always answer false. The role list is
-- fn_is_platform_admin()'s own. This migration asserts at apply that the live
-- function still says exactly that, so the two cannot start out different.
-- Callers still ask only about themselves (unchanged).
-- get_commander_access_details also says why, with 'isPlatformStaff'.
--
-- Today this changes the answer for exactly one account. There are three
-- platform staff accounts. The two admins already had Commander access through
-- their own venues, so only daniel@smarter.poker changes. Every account that is
-- not platform staff answers exactly as before (the rehearsal checks all of
-- them).
--
-- Every edit is an asserted substitution: the live md5 is pinned, the old
-- clause must occur exactly once, and the reverse substitution must reproduce
-- the pinned text. There is no new table, column, function or grant.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   has_commander_access(uuid)                 a6f1fc22c2733abeafacdde54fa9b863
--   get_commander_access_details(uuid)         addade098de326d6207cfab11964a9d4
--   fn_is_platform_admin() (read, not changed) ed89787c7b832e76a886734e16a27c3d
--
-- @live-proof: (SELECT position('exists (select 1 from profiles where id = v_target and role in (''admin'', ''superadmin'', ''god''))' IN pg_get_functiondef('public.has_commander_access(uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('ps  as (select 1 from profiles where id = v_target and role in (''admin'', ''superadmin'', ''god''))' IN pg_get_functiondef('public.get_commander_access_details(uuid)'::regprocedure)) > 0 AND position('''isPlatformStaff'',      exists(select 1 from ps),' IN pg_get_functiondef('public.get_commander_access_details(uuid)'::regprocedure)) > 0)
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $m$
DECLARE
  r record; v_oid oid; v_def text; v_new text; v_back text; v_n integer;
BEGIN
  -- The role list below is fn_is_platform_admin()'s. Refuse if it has moved.
  IF position('RETURN v_role IN (''admin'', ''superadmin'', ''god'');'
              IN pg_get_functiondef('public.fn_is_platform_admin()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'fn_is_platform_admin() no longer admits exactly admin, superadmin and god; rebuild this rule on its new list';
  END IF;

  FOR r IN SELECT * FROM (VALUES
    ($f$has_commander_access$f$, $p$a6f1fc22c2733abeafacdde54fa9b863$p$,
     $o$    exists (select 1 from commander_home_groups where owner_id = v_target);
end$o$,
     $n$    exists (select 1 from commander_home_groups where owner_id = v_target) or
    -- PLATFORM STAFF OPEN COMMANDER (2026-10-01, Ruling 22): the role that
    -- fn_is_platform_admin() admits, read for the user asked about, because the
    -- World Hub asks as the server on that user's behalf.
    exists (select 1 from profiles where id = v_target and role in ('admin', 'superadmin', 'god'));
end$n$,
     NULL::text, NULL::text),
    ($f$get_commander_access_details$f$, $p$addade098de326d6207cfab11964a9d4$p$,
     $o$    hg  as (select id, name from commander_home_groups where owner_id = v_target)
  select jsonb_build_object(
    'hasAccess', (exists(select 1 from cl) or exists(select 1 from sub)
                  or exists(select 1 from cs where role in ('owner','manager'))
                  or exists(select 1 from hg)),$o$,
     $n$    hg  as (select id, name from commander_home_groups where owner_id = v_target),
    -- PLATFORM STAFF OPEN COMMANDER (2026-10-01, Ruling 22): the role that
    -- fn_is_platform_admin() admits, read for the user asked about, because the
    -- World Hub asks as the server on that user's behalf.
    ps  as (select 1 from profiles where id = v_target and role in ('admin', 'superadmin', 'god'))
  select jsonb_build_object(
    'hasAccess', (exists(select 1 from cl) or exists(select 1 from sub)
                  or exists(select 1 from cs where role in ('owner','manager'))
                  or exists(select 1 from hg) or exists(select 1 from ps)),
    'isPlatformStaff',      exists(select 1 from ps),$n$,
     $o2$        'clubs', '[]'::jsonb, 'homeGroups', '[]'::jsonb);$o2$,
     $n2$        'clubs', '[]'::jsonb, 'homeGroups', '[]'::jsonb, 'isPlatformStaff', false);$n2$)
  ) AS t(fn, pin, old, new, old2, new2)
  LOOP
    SELECT p.oid INTO STRICT v_oid FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.fn;
    v_def := pg_get_functiondef(v_oid);
    IF md5(v_def) <> r.pin THEN
      RAISE EXCEPTION '% is not the pinned text (md5 %, pinned %)', r.fn, md5(v_def), r.pin;
    END IF;
    v_n := (length(v_def) - length(replace(v_def, r.old, ''))) / length(r.old);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: the clause to change occurs % times, expected 1', r.fn, v_n;
    END IF;
    v_new := replace(v_def, r.old, r.new);
    IF r.old2 IS NOT NULL THEN
      v_n := (length(v_def) - length(replace(v_def, r.old2, ''))) / length(r.old2);
      IF v_n <> 1 THEN
        RAISE EXCEPTION '%: the second clause to change occurs % times, expected 1', r.fn, v_n;
      END IF;
      v_new := replace(v_new, r.old2, r.new2);
    END IF;
    EXECUTE v_new;
    v_back := replace(pg_get_functiondef(v_oid), r.new, r.old);
    IF r.old2 IS NOT NULL THEN
      v_back := replace(v_back, r.new2, r.old2);
    END IF;
    IF md5(v_back) <> r.pin THEN
      RAISE EXCEPTION '%: the reverse substitution does not reproduce the pinned text', r.fn;
    END IF;
  END LOOP;
END $m$;

-- ---------------------------------------------------------------------------
-- What must be true now
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  r record; v_txt text;
BEGIN
  v_txt := pg_get_functiondef('public.has_commander_access(uuid)'::regprocedure);
  IF position('exists (select 1 from profiles where id = v_target and role in (''admin'', ''superadmin'', ''god''))' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'has_commander_access does not admit platform staff';
  END IF;
  v_txt := pg_get_functiondef('public.get_commander_access_details(uuid)'::regprocedure);
  IF position('or exists(select 1 from hg) or exists(select 1 from ps)),' IN v_txt) = 0
     OR position('''isPlatformStaff'',      exists(select 1 from ps),' IN v_txt) = 0
     OR position('''homeGroups'', ''[]''::jsonb, ''isPlatformStaff'', false);' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'get_commander_access_details does not admit platform staff and say so';
  END IF;
  -- callers still ask only about themselves
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('has_commander_access', 'get_commander_access_details')
  LOOP
    IF position('v_target := v_uid;' IN pg_get_functiondef(r.oid)) = 0 THEN
      RAISE EXCEPTION '% no longer holds a caller to their own account', r.proname;
    END IF;
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable without an account', r.proname;
    END IF;
  END LOOP;

  -- the arena keeps its owner, and nobody got a club back
  IF (SELECT owner_id FROM public.clubs WHERE asset = 'diamonds') IS DISTINCT FROM '00000000-0000-0000-0000-000000000001'::uuid
     OR EXISTS (SELECT 1 FROM public.clubs WHERE owner_id = '2d1cd6c3-5700-4af9-a271-d4863fdab20d') THEN
    RAISE EXCEPTION 'the arena changed hands, or the god account owns a club again';
  END IF;

  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'a Diamond switch is open';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  RAISE NOTICE 'platform staff open Commander: both access doors admit the role fn_is_platform_admin() admits, for the user asked about, and say so; the arena keeps its system owner';
END $m$;

COMMIT;
