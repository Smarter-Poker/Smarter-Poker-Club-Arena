-- Repo copy of production migrations applied 2026-08-31 via Supabase MCP:
--   phase4_close_the_anon_definer_surface
--   phase4_anon_loses_the_logged_in_surface
-- See docs/changelog/2026-08-31-phase4-security-sweep.md
--
-- CLOSING THE ANON-EXECUTABLE SECURITY DEFINER SURFACE.
--
-- Measured before: 83 SECURITY DEFINER functions in `public` were EXECUTE-able
-- by `anon` — a caller with NO LOGIN AT ALL. Postgres grants EXECUTE to PUBLIC
-- by default and Supabase publishes every public function as an RPC, so each
-- was a door somebody left open rather than a door somebody built. After: 22
-- (19 ours + 3 PostGIS st_estimatedextent overloads).
--
-- WHAT WAS DELIBERATELY NOT TOUCHED, because a blanket revoke takes the
-- product down:
--   * SIX functions called from inside RLS POLICY expressions
--     (fn_can_view_post, fn_club_chat_is_silenced, fn_home_is_group_staff,
--     fn_my_club_ids, fn_table_chat_is_silenced, is_admin). A policy is
--     evaluated as the QUERYING role, so revoking EXECUTE would make every
--     SELECT on those tables fail outright.
--   * The genuine pre-login/public surface: username + club-name
--     availability, public profile/venue/home-group detail, nearby live
--     games, ads, daily challenge, similar questions, and the three
--     leaderboard functions.
--
-- EVIDENCE EVERY REVOKE RESTS ON. For each function closed: not referenced in
-- any RLS policy, not in any view definition, not called by any SECURITY
-- INVOKER function, and not referenced in club-arena/src, World Hub pages/ or
-- World Hub src/. Their only callers are other SECURITY DEFINER functions,
-- whose bodies run as the owner — so an EXECUTE grant to anon bought those
-- callers nothing and cost a door.
--
-- THE REAL FINDING. fn_nit_evictions RETURNS TABLE(user_id uuid, vpip
-- numeric, required integer, hands integer) and does NOT consult auth.uid().
-- An unauthenticated caller could enumerate PER-PLAYER VPIP STATISTICS — who
-- is being watched for nit eviction, how loose they play, over how many
-- hands. Closed to anon, kept for logged-in club/admin surfaces.
--
-- Trigger functions were also revoked: PostgreSQL checks EXECUTE on a trigger
-- function when the TRIGGER IS CREATED, never when it fires, so revoking
-- cannot break DML. Pure surface reduction.
--
-- VERIFIED AGAINST THE LIVE REST API AS anon, not asserted:
--   check_username_available      HTTP 200 true     (pre-login surface intact)
--   get_daily_challenge           HTTP 200
--   fn_global_leaderboard_period  HTTP 200
--   fn_resolve_ads (real args)    HTTP 200
--   GET /tournaments              HTTP 200 + rows   (RLS + policy helpers OK)
--   fn_nit_evictions              HTTP 404 PGRST202 (closed)
--   fn_create_club_atomic         HTTP 404
--   fn_search_players             HTTP 404
--   fn_audit_overlays             HTTP 404
--   fn_money_path_reaches_club_scope HTTP 404
--   fn_spin_reserve_owner         HTTP 404
--   v_spin_unfilled_waits         HTTP 401

DO $$
DECLARE
  sig text;
  group_a text[] := ARRAY[
    'fn_audit_analysis_watchdog','fn_audit_empty_freerolls',
    'fn_audit_layer_silence_and_coverage','fn_audit_league_coverage',
    'fn_audit_league_pooled_findings','fn_audit_overlays',
    'fn_concurrent_game_load','fn_fee_is_accounted_for',
    'fn_freeroll_fill_targets','fn_hu_shortfall_candidates',
    'fn_money_path_reaches_club_scope','fn_overlay_at_risk',
    'fn_rls_on_new_public_table'];
  group_b text[] := ARRAY[
    'fn_caller_can_moderate_user','fn_club_is_staff','fn_club_union_join_blockers',
    'fn_league_pooled','sp_cosmetic_is_owned','sp_theme_asset_is_owned'];
  group_c text[] := ARRAY[
    'fn_audit_club_delete','fn_audit_club_entry_mutation','fn_audit_club_member_change',
    'fn_audit_club_settings_change','fn_clear_seats_on_game_end','fn_club_member_notes_guard',
    'fn_club_members_bot_follows_horse','fn_club_members_ledger_writer',
    'fn_club_members_no_agent_cycle','fn_enforce_club_enters_union_empty',
    'fn_enforce_table_union_ownership_update','fn_enforce_tournament_capacity',
    'fn_enforce_tournament_union_ownership_update','fn_guard_one_live_tournament_seat',
    'fn_home_audit_privileged_write','fn_new_seat_clear_sitout',
    'fn_no_live_seat_on_finished_game','fn_reject_horse_name_on_human',
    'fn_seat_change_syncs_seat_first_count','fn_spin_pool_follows_union_membership',
    'fn_stamp_entry_club','fn_stamp_seat_club','fn_union_totals_follow_club_counts',
    'trg_finalize_trivia_session_stats_v3','trg_profiles_assign_player_number',
    'trg_tournament_player_name','trg_tournaments_cancel_must_refund',
    'trg_tournaments_rank_before_complete','trg_validate_shop_theme_preset'];
  -- Second pass: logged-in flows. Ten of these consult auth.uid(), which is
  -- NULL for anon, so the revoke is provably a no-op for them; the other
  -- three (fn_nit_check, fn_nit_evictions, fn_spin_reserve_owner) do not, and
  -- were genuinely readable without an account.
  group_d text[] := ARRAY[
    'fn_cancel_club_join_request','fn_create_club_atomic','fn_join_club_atomic',
    'fn_preview_club_join','fn_get_club_entry_flags','fn_get_club_creation_eligibility',
    'fn_get_player_search_preferences','fn_set_player_search_preferences',
    'fn_search_players','fn_track_club_entry_event',
    'fn_nit_check','fn_nit_evictions','fn_spin_reserve_owner'];
BEGIN
  FOR sig IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY (group_a || group_c)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
  END LOOP;

  FOR sig IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY (group_b || group_d)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', sig);
  END LOOP;
END $$;

-- Operator telemetry: which spins are waiting to fill, how long, how many
-- chips are parked. Aggregate counts only — no user, hand or balance data —
-- so posture rather than a leak, but anon has no reason to read the floor's
-- fill-rate problems. Same treatment the shell-telemetry views got on
-- 2026-08-30: revoke anon, keep authenticated, leave SECURITY DEFINER alone.
REVOKE ALL ON public.v_spin_unfilled_waits FROM PUBLIC, anon;
GRANT SELECT ON public.v_spin_unfilled_waits TO authenticated, service_role;

DO $$
DECLARE v_now int; v_helpers int;
BEGIN
  SELECT count(*) INTO v_helpers
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_can_view_post','fn_club_chat_is_silenced','fn_home_is_group_staff',
                       'fn_my_club_ids','fn_table_chat_is_silenced','is_admin')
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_helpers < 6 THEN
    RAISE EXCEPTION 'a policy helper lost its grant — RLS reads would break (% of 6)', v_helpers;
  END IF;

  IF NOT (has_function_privilege('anon','public.check_username_available(text)','EXECUTE')
          AND has_function_privilege('anon','public.get_public_profile_by_username(text)','EXECUTE')) THEN
    RAISE EXCEPTION 'the anonymous signup/profile surface was revoked by mistake';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname IN ('fn_nit_evictions','fn_nit_check')
                AND has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'nit statistics are still readable by anon';
  END IF;

  SELECT count(*) INTO v_now
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege('anon',p.oid,'EXECUTE');
  RAISE NOTICE 'anon-executable SECURITY DEFINER functions: 83 -> %', v_now;
END $$;
