-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831112232; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 4: CLOSING THE ANON-EXECUTABLE SECURITY DEFINER SURFACE
--
-- Measured before: 83 SECURITY DEFINER functions in `public` are EXECUTE-able
-- by `anon` — a caller with NO LOGIN AT ALL. Postgres grants EXECUTE to PUBLIC
-- by default and Supabase publishes every public function as an RPC, so each
-- one is a door somebody left open rather than a door somebody built.
--
-- WHAT THIS DOES *NOT* TOUCH, AND WHY. A blanket revoke here would take the
-- product down, so every candidate was classified first:
--
--   * SIX are called from inside RLS POLICY expressions (fn_can_view_post,
--     fn_club_chat_is_silenced, fn_home_is_group_staff, fn_my_club_ids,
--     fn_table_chat_is_silenced, is_admin). A policy is evaluated as the
--     QUERYING role, so revoking EXECUTE from anon/authenticated would make
--     every SELECT on those tables fail outright. Untouched.
--   * The genuine public/pre-login surface is untouched: username and club
--     name availability, public profile/venue/home-group detail, nearby live
--     games, ads, the daily challenge, similar questions, leaderboards,
--     player search and the club join/create flows — all verified as真 called
--     from club-arena/src or the World Hub by name.
--   * get_home_group_public_detail and get_venue_public_detail have zero
--     client references today, but they are named and shaped as anonymous
--     public endpoints. Left alone deliberately: absence from a grep is not
--     proof of disuse, and these read public pages.
--
-- WHAT IT DOES CLOSE, and the evidence each rests on. For every function
-- below: not referenced in any RLS policy, not referenced in any view
-- definition, not called by any SECURITY INVOKER function, and not referenced
-- anywhere in club-arena/src, World Hub pages/ or World Hub src/. Their only
-- callers are other SECURITY DEFINER functions, whose bodies execute as the
-- owner — so an EXECUTE grant to anon buys those callers nothing and costs a
-- door.
--
-- GROUP A — operator audits, watchdogs and money-path predicates. No browser
-- has any business calling these; service_role only.
-- GROUP B — authorization/ownership predicates. anon revoked; `authenticated`
-- deliberately KEPT, because a logged-in surface plausibly asks these and a
-- grep across two repos is weaker evidence than a policy reference.
-- GROUP C — trigger functions. PostgreSQL checks EXECUTE on a trigger
-- function when the TRIGGER IS CREATED, never when it fires, so revoking
-- cannot break DML. Pure surface reduction.
-- ═══════════════════════════════════════════════════════════════════════════

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
BEGIN
  -- A and C: anon AND authenticated revoked, service_role keeps it.
  FOR sig IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY (group_a || group_c)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
  END LOOP;

  -- B: anon revoked, authenticated deliberately retained.
  FOR sig IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY (group_b)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', sig);
  END LOOP;
END $$;

-- v_spin_unfilled_waits: a SECURITY DEFINER view of operator telemetry —
-- which spins are waiting to fill, how long, and how many chips are parked in
-- them. Aggregate counts only, no user, hand or balance data, so this is
-- posture rather than a leak; but anon has no reason to read the floor's
-- fill-rate problems. Matches the treatment the shell-telemetry views got on
-- 2026-08-30: revoke anon, keep authenticated, leave SECURITY DEFINER alone
-- (flipping to security_invoker would silently empty an operator dashboard
-- rather than fix anything).
REVOKE ALL ON public.v_spin_unfilled_waits FROM PUBLIC, anon;
GRANT SELECT ON public.v_spin_unfilled_waits TO authenticated, service_role;

DO $$
DECLARE v_anon_before int := 83; v_anon_now int; v_policy_helpers int;
BEGIN
  SELECT count(*) INTO v_anon_now
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND has_function_privilege('anon', p.oid, 'EXECUTE');

  -- The six policy helpers MUST still be callable by anon and authenticated,
  -- or every SELECT on the tables whose policies call them fails.
  SELECT count(*) INTO v_policy_helpers
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_can_view_post','fn_club_chat_is_silenced','fn_home_is_group_staff',
                       'fn_my_club_ids','fn_table_chat_is_silenced','is_admin')
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_policy_helpers < 6 THEN
    RAISE EXCEPTION 'a policy helper lost its grant — RLS reads would break (% of 6 intact)', v_policy_helpers;
  END IF;

  -- The public pre-login surface must survive.
  IF NOT (has_function_privilege('anon', 'public.check_username_available(text)', 'EXECUTE')
          AND has_function_privilege('anon', 'public.get_public_profile_by_username(text)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'the anonymous signup/profile surface was revoked by mistake';
  END IF;

  RAISE NOTICE 'anon-executable SECURITY DEFINER functions: % -> %', v_anon_before, v_anon_now;
  IF v_anon_now >= v_anon_before THEN
    RAISE EXCEPTION 'expected the anon surface to shrink, got %', v_anon_now;
  END IF;
END $$;

