-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424020349 "20260421187000_hg_tighten_anon_grants_on_admin_and_user_only_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ccb4d34699941a53be464d8a1d2a9728 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Bug hunt: 5 RPCs leaked anon EXECUTE despite requiring authenticated
-- identity (auth.uid() checks). Body would reject but grants widen
-- the attack + enumeration surface. Also 14 trigger-helper functions
-- have PUBLIC grants they don't need (triggers fire regardless of
-- grants; removing from PostgREST catalog is cleanliness).

-- ── 5 RPCs: auth-only callable ──
REVOKE EXECUTE ON FUNCTION public.list_home_content_reports(uuid, text, text, integer, integer) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_home_content_report_detail(uuid, uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_home_ban_appeal(uuid, text, uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.withdraw_home_ban_appeal(uuid, uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_get_home_games_onboarding_status(uuid) FROM anon, PUBLIC;

-- ── 14 trigger-helper functions: PUBLIC cleanup ──
-- Triggers invoke these regardless of grants, but PUBLIC+anon grants
-- make them appear in PostgREST and can be called directly. Lock down.
DO $$
DECLARE v_fn text; v_fns text[] := ARRAY[
  'fn_block_home_member_ban_evasion',
  'fn_enforce_home_club_announcement_insert',
  'fn_enforce_home_content_report_insert',
  'fn_enforce_home_game_field_permissions',
  'fn_enforce_home_game_photos_is_featured',
  'fn_enforce_home_game_photos_is_featured_on_insert',
  'fn_enforce_home_group_field_permissions',
  'fn_enforce_home_member_field_permissions',
  'fn_enforce_home_members_self_insert',
  'fn_enforce_home_poll_field_permissions',
  'fn_enforce_home_post_field_permissions',
  'fn_enforce_home_promotion_request_insert',
  'fn_enforce_home_rsvp_field_permissions',
  'fn_home_protect_identity_fields'
];
BEGIN
  FOREACH v_fn IN ARRAY v_fns LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION public.%I() FROM anon, authenticated, PUBLIC',
      v_fn);
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  -- Some of these may not exist or have different sigs; not fatal
  RAISE NOTICE 'partial revoke: %', SQLERRM;
END $$;

-- ── Public read-only fns — confirm legitimate anon paths stay ──
-- These SHOULD remain anon-callable (discovery/analytics):
--   generate_home_group_ical
--   get_home_group_public_detail
--   search_home_groups, search_home_groups_v2
--   track_home_group_share_click, track_home_group_view
--   verify_home_games_health
-- No action needed for these.
