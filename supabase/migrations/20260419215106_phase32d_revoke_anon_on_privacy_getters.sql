-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419215106 "phase32d_revoke_anon_on_privacy_getters"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 351dab1d9e026505ffebfc30d1646156 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 32D: REVOKE anon access on per-user getters (privacy leak mitigation).
-- Authenticated access is preserved to avoid breaking the frontend.
-- Tier-2 risk (authenticated user can still call with any p_user_id) is documented
-- and requires valid JWT to exploit — mitigates wholesale scraping via anon key.
DO $$
DECLARE r RECORD; v_revoked int := 0; v_signature text;
BEGIN
    FOR r IN 
        SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' 
           AND p.prosecdef = true
           AND has_function_privilege('anon', p.oid, 'EXECUTE')
           AND pg_get_functiondef(p.oid) NOT ILIKE '%auth.uid()%'
           AND (
             -- Per-user readers that expose private info
             p.proname IN (
               'get_diamond_balance','fn_get_user_xp','fn_get_vip_subscription',
               'fn_get_friends','fn_get_conversations','fn_get_user_conversations',
               'fn_get_social_feed','fn_get_social_feed_v2','fn_get_player_note',
               'fn_get_stories','fn_get_leaderboard',
               'get_active_leaks','get_agent_dashboard','get_agent_commission_history',
               'get_agent_commission_summary','get_arcade_user_stats',
               'get_available_rotation','get_club_agents','get_club_financial_summary',
               'get_club_leaderboard','get_club_traffic',
               'get_host_reputation','get_message_reactions',
               'get_next_training_question','get_pending_celebrations',
               'get_player_rake_total','get_profile_picture_history',
               'get_promo_status','get_tournament_details',
               'get_union_bbj_status','get_union_leaderboard','get_union_rake_for_period',
               'get_unread_leak_alerts','get_user_achievements',
               'get_user_home_games_badges','get_user_leaderboard_rank',
               'get_user_level_stats','get_user_reward_summary',
               'get_user_total_xp','get_user_vip_status','get_waitlist_position',
               'get_anti_cheat_stats','get_bbj_pool','get_club_member_count',
               'get_active_hand_snapshot','get_next_waitlist_position',
               'get_settlement_periods','get_table_state','get_top_mission_completers',
               'get_available_horses','fn_get_active_player_count','fn_get_club_member_count',
               'fn_get_table_settings',
               -- Private message search
               'fn_search_messages',
               -- Rakeback calc uses p_user_id
               'fn_calculate_rakeback',
               -- Level advancement per-user check
               'fn_check_level_advancement','fn_check_feature_access',
               -- Home group staff predicates (OK but belt+suspenders)
               'fn_home_caller_is_game_staff','fn_home_is_group_staff',
               'fn_home_list_seats'
             )
           )
    LOOP
        v_signature := 'public.' || quote_ident(r.proname) || '(' || r.args || ')';
        BEGIN
            EXECUTE 'REVOKE EXECUTE ON FUNCTION ' || v_signature || ' FROM anon';
            v_revoked := v_revoked + 1;
        EXCEPTION WHEN OTHERS THEN NULL; END;
    END LOOP;
    RAISE NOTICE 'Phase 32D: revoked anon on % privacy getters', v_revoked;
END $$;
