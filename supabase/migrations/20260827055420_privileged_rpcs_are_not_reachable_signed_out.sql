-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827055420; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- PRIVILEGED RPCs ARE NOT REACHABLE SIGNED OUT
-- ═══════════════════════════════════════════════════════════════════════════
-- Supabase's advisor reports 96 SECURITY DEFINER functions the UNAUTHENTICATED
-- `anon` role can call over /rest/v1/rpc. The advisor flags the GRANT, not
-- exploitability, so the dangerous-looking ones were probed as role anon with
-- no JWT -- auth.uid() NULL, exactly as an anonymous REST call -- inside
-- transactions that were rolled back.
--
-- NO VULNERABILITY WAS FOUND. Both false alarms are recorded here, because the
-- next person reading that advisor list will draw the same wrong conclusions:
--
--   fn_take_seat_and_buy_in  REFUSED outright, SQLSTATE 28000,
--                            "requires an authenticated caller".
--
--   fn_admin_update_agent    LOOKED like an anonymous caller setting an agent's
--                            role, status, credit limit and commission rate,
--                            because it returned without raising. Two further
--                            checks say otherwise: a before/after probe showed
--                            MUTATED_BY_ANON = false, and its body already
--                            carries
--                              IF v_caller IS NULL THEN RETURN
--                                jsonb_build_object('success', false,
--                                                   'error','authentication required');
--                            It returns a STRUCTURED FAILURE instead of raising,
--                            which is the right contract for a JSON RPC and is
--                            why PERFORM made it look silent. NOT TOUCHED:
--                            "fixing" it to RAISE would break the admin UI that
--                            reads {success:false}.
--
-- So this is defence in depth, not a fix. An RPC that only makes sense for a
-- signed-in caller should not be REACHABLE signed out, so the guard inside it
-- is the second line rather than the only one.
--
-- WHY THE FIRST ATTEMPT AT THIS MIGRATION DID NOTHING, caught by its own
-- assertion: these functions are granted to PUBLIC, and `anon` inherits from
-- PUBLIC, so REVOKE ... FROM anon is a NO-OP while the PUBLIC grant stands.
-- The revoke has to be FROM PUBLIC, and then authenticated and service_role
-- have to be granted back explicitly or every signed-in caller loses access
-- too. Asserted below in both directions.
--
-- ROLLBACK: GRANT EXECUTE ON FUNCTION <sig> TO PUBLIC; for each listed function.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public'
      AND p.prosecdef
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
      AND p.proname IN (
        'fn_admin_update_agent','fn_create_agent','fn_agent_attach_player',
        'fn_action_player_report','fn_list_player_reports',
        'fn_take_seat_and_buy_in','fn_trivia_prize_wheel_spin','fn_trivia_grant_item',
        'fn_redeem_vip_points','fn_trivia_consume_item','buy_streak_freeze',
        'claim_social_profile',
        'ca_club_members_overview','ca_club_my_downline',
        'ca_horse_daily_audit','ca_brain_telemetry','ca_horse_hand_reviews',
        'ca_horse_review_summary','fn_hand_history_bloat_report','fn_truly_unused_indexes',
        'fn_unaccounted_seat_exits','fn_deprecated_table_usage','fn_audit_layer_silence',
        'fn_hand_history_prune_backlog','fn_club_home_scope_parity',
        'fn_launch_table_from_template','fn_reveal_rabbit_hunt','pb_log_hand',
        'bump_challenge_progress','update_trivia_streak','fn_trivia_pvp_record_result',
        'fn_bump_friend_challenge_progress','fn_respond_friend_challenge'
      )
  LOOP
    /* FROM PUBLIC first -- anon inherits PUBLIC, so revoking anon alone does
       nothing. Then hand the access back to the roles that should have it. */
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'closed % privileged function(s) to anonymous callers', n;
END $$;

DO $$
DECLARE v_left int; v_public int; v_auth int;
BEGIN
  SELECT count(*) INTO v_left
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
    AND has_function_privilege('anon', p.oid, 'EXECUTE')
    AND p.proname IN ('fn_admin_update_agent','fn_create_agent','claim_social_profile',
                      'ca_club_members_overview','fn_redeem_vip_points','fn_take_seat_and_buy_in',
                      'fn_action_player_report','ca_club_my_downline');
  IF v_left > 0 THEN RAISE EXCEPTION '% privileged function(s) still anon-callable', v_left; END IF;

  -- Signed-in users must be UNAFFECTED.
  SELECT count(*) INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('fn_admin_update_agent','fn_take_seat_and_buy_in','ca_club_members_overview',
                      'fn_redeem_vip_points','claim_social_profile')
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth < 5 THEN
    RAISE EXCEPTION 'authenticated lost access (% of 5) - signed-in flows would break', v_auth;
  END IF;

  -- Signed-out discovery must still work.
  SELECT count(*) INTO v_public
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('check_username_available','get_public_profile_by_username',
                      'get_venue_public_detail','find_live_games_nearby')
    AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_public < 4 THEN
    RAISE EXCEPTION 'public discovery broken (% of 4 reachable)', v_public;
  END IF;

  RAISE NOTICE 'privileged surface closed to anon; authenticated and public discovery intact';
END $$;
