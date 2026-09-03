-- 20260903035252_four_rpcs_still_told_a_super_agent_which_players_are_horses.sql
-- RECOVERED 2026-09-03 from supabase_migrations.schema_migrations.
-- This migration was APPLIED to production on 2026-09-03 at 03:52:52 UTC but was never committed, so the repo
-- could not reproduce the database and applied-migrations-recorded.yml was red.
-- The body below is the exact SQL the database recorded; it is NOT a
-- reconstruction. Re-applying it is a no-op - it is already in production.

-- FOUR RPCS STILL TOLD A SUPER AGENT WHICH PLAYERS ARE HORSES.
--
-- fn_can_see_horse_flag(club) is the estate's answer to who may know: a
-- platform admin, or an owner / co_owner / admin of that club. ca_club_members,
-- ca_club_top_players and fn_club_cashier_members_v2 already route the flag
-- through it, with the rule written in their own source - "staff get the truth,
-- everyone else gets a uniform false."
--
-- Four browser-reachable routines never got the treatment:
--
--   ca_club_player_breakdown        the Club Data players tab
--   ca_club_player_page             its paging
--   ca_club_player_export_start     its CSV export
--   fn_club_cashier_members_page_v3 the PAGED successor to a masked v2
--
-- The first three are gated by ca_can_view_club_finances, which admits
-- SUPER_AGENT - a role fn_can_see_horse_flag deliberately excludes. So a super
-- agent opening Club Data was being told, per row, which of the club's players
-- are horses. The fourth is the more ordinary mistake: v2 masks, and the paged
-- v3 written after it does not, so the same data leaked through the newer door.
--
-- This is being fixed BEFORE the flag is painted anywhere. Phase 4 exists to
-- make horses visible to an owner, and shipping that on top of an unmasked
-- read would have turned a quiet leak into a labelled one.
--
-- The rewrite is done against pg_get_functiondef rather than by restating four
-- long bodies, so nothing else in them can drift by accident, and every
-- replacement asserts that it actually matched.

DO $$
DECLARE
  v_def  text;
  v_new  text;
BEGIN
  ---------------------------------------------------------------- breakdown --
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'ca_club_player_breakdown';
  v_new := replace(v_def,
    '''is_horse'',COALESCE(pr.is_horse,false)',
    '''is_horse'',(public.fn_can_see_horse_flag(p_club_id) AND COALESCE(pr.is_horse,false))');
  IF v_new = v_def THEN RAISE EXCEPTION 'ca_club_player_breakdown: flag expression not found'; END IF;
  EXECUTE v_new;

  --------------------------------------------------------------- player page --
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'ca_club_player_page';
  v_new := replace(v_def,
    'pr.avatar_url,COALESCE(pr.is_horse,false) is_horse',
    'pr.avatar_url,(public.fn_can_see_horse_flag(p_club_id) AND COALESCE(pr.is_horse,false)) is_horse');
  IF v_new = v_def THEN RAISE EXCEPTION 'ca_club_player_page: flag expression not found'; END IF;
  EXECUTE v_new;

  -------------------------------------------------------------------- export --
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'ca_club_player_export_start';
  v_new := replace(v_def,
    'pr.avatar_url,COALESCE(pr.is_horse,false) is_horse',
    'pr.avatar_url,(public.fn_can_see_horse_flag(p_club_id) AND COALESCE(pr.is_horse,false)) is_horse');
  IF v_new = v_def THEN RAISE EXCEPTION 'ca_club_player_export_start: flag expression not found'; END IF;
  EXECUTE v_new;

  ------------------------------------------------------------- cashier page --
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'fn_club_cashier_members_page_v3';
  v_new := replace(v_def,
    'm.avatar_url, m.is_horse',
    'm.avatar_url, (public.fn_can_see_horse_flag(p_club_id) AND COALESCE(m.is_horse,false))');
  IF v_new = v_def THEN RAISE EXCEPTION 'fn_club_cashier_members_page_v3: flag expression not found'; END IF;
  EXECUTE v_new;

  RAISE NOTICE 'four horse-flag readers masked';
END $$;