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
-- are horses, and could export the same. The fourth is the more ordinary
-- mistake: v2 masks, and the paged v3 written after it does not, so the same
-- data leaked through the newer door.
--
-- This is fixed BEFORE the flag is painted anywhere. Phase 4 exists to make
-- horses visible to an owner, and shipping that on top of an unmasked read
-- would have turned a quiet leak into a labelled one.
--
-- WHY THE REWRITE IS DONE THIS WAY. Four long bodies restated by hand is four
-- chances to change something nobody meant to change. Rewriting
-- pg_get_functiondef output touches exactly the flag expression and nothing
-- else, and every replacement asserts that it matched - a rename upstream makes
-- this migration fail loudly rather than pass while masking nothing.
--
-- NOT TOUCHED, deliberately: ca_horse_hand_reviews, ca_horse_league_card,
-- ca_horse_review_summary and ca_horse_tag_trends are horse-management
-- surfaces, gated on their own caller checks - they are ABOUT horses and their
-- audience already knows. fn_horses_without_social_identity is anon-reachable
-- but SECURITY INVOKER, so row-level security answers for it.

DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  ---------------------------------------------------------------- breakdown --
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'ca_club_player_breakdown';
  IF v_def IS NOT NULL THEN
    v_new := replace(v_def,
      '''is_horse'',COALESCE(pr.is_horse,false)',
      '''is_horse'',(public.fn_can_see_horse_flag(p_club_id) AND COALESCE(pr.is_horse,false))');
    IF v_new = v_def THEN
      RAISE EXCEPTION 'ca_club_player_breakdown: horse flag expression not found';
    END IF;
    EXECUTE v_new;
  END IF;

  --------------------------------------------------------------- player page --
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'ca_club_player_page';
  IF v_def IS NOT NULL THEN
    v_new := replace(v_def,
      'pr.avatar_url,COALESCE(pr.is_horse,false) is_horse',
      'pr.avatar_url,(public.fn_can_see_horse_flag(p_club_id) AND COALESCE(pr.is_horse,false)) is_horse');
    IF v_new = v_def THEN
      RAISE EXCEPTION 'ca_club_player_page: horse flag expression not found';
    END IF;
    EXECUTE v_new;
  END IF;

  -------------------------------------------------------------------- export --
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'ca_club_player_export_start';
  IF v_def IS NOT NULL THEN
    v_new := replace(v_def,
      'pr.avatar_url,COALESCE(pr.is_horse,false) is_horse',
      'pr.avatar_url,(public.fn_can_see_horse_flag(p_club_id) AND COALESCE(pr.is_horse,false)) is_horse');
    IF v_new = v_def THEN
      RAISE EXCEPTION 'ca_club_player_export_start: horse flag expression not found';
    END IF;
    EXECUTE v_new;
  END IF;

  ------------------------------------------------------------- cashier page --
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'fn_club_cashier_members_page_v3';
  IF v_def IS NOT NULL THEN
    v_new := replace(v_def,
      'm.avatar_url, m.is_horse',
      'm.avatar_url, (public.fn_can_see_horse_flag(p_club_id) AND COALESCE(m.is_horse,false))');
    IF v_new = v_def THEN
      RAISE EXCEPTION 'fn_club_cashier_members_page_v3: horse flag expression not found';
    END IF;
    EXECUTE v_new;
  END IF;

  RAISE NOTICE 'four horse-flag readers masked';
END $$;
