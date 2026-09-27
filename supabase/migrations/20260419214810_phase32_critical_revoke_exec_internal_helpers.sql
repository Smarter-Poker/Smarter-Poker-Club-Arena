-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419214810 "phase32_critical_revoke_exec_internal_helpers"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1d84acb7644b017edc2efa3e39084283 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
-- PHASE 32 — CRITICAL SECURITY: REVOKE EXECUTE ON INTERNAL HELPERS
-- 
-- Supabase's default behavior is GRANT EXECUTE TO PUBLIC on new functions.
-- For SECURITY DEFINER functions that modify state, this means anon and
-- authenticated can directly call functions that were designed to be
-- invoked by the backend (service_role) only.
--
-- The fix: REVOKE EXECUTE from anon and authenticated on all internal
-- money/state helpers, keeping service_role access only. Backend API
-- routes already authenticate the user and then call service_role;
-- this is the correct architecture.
--
-- We programmatically iterate all SECURITY DEFINER functions matching
-- sensitive name patterns — covering money movement, wallet credits/debits,
-- state mutations, tournament ops, achievement claims, bonuses, etc.
--
-- Impact: If any frontend code was calling these directly instead of
-- going through an authenticated API route, it will break and need to
-- be refactored to use an API route. This is the correct behavior —
-- direct client→DB state mutation with no auth check is a vulnerability.
-- ══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
    r RECORD;
    v_revoked int := 0;
    v_skipped int := 0;
    v_signature text;
BEGIN
    FOR r IN 
        SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' 
           AND p.prosecdef = true
           AND (
             -- Money movement
                p.proname LIKE 'atomic_%'
             OR p.proname LIKE 'add_diamonds%'
             OR p.proname LIKE 'add_vip_points%'
             OR p.proname LIKE 'add_xp%'
             OR p.proname LIKE 'add_player_xp%'
             OR p.proname LIKE 'add_to_%_wallet%'
             OR p.proname LIKE 'award_%'
             OR p.proname LIKE 'credit_%'
             OR p.proname LIKE 'debit_%'
             OR p.proname LIKE 'deduct_%'
             OR p.proname LIKE 'distribute_%'
             OR p.proname LIKE 'transfer_%'
             OR p.proname LIKE 'wallet_%'
             OR p.proname LIKE 'mint_%'
             OR p.proname LIKE 'claim_%'
             OR p.proname LIKE 'pay_%'
             OR p.proname LIKE 'redeem_%'
             OR p.proname LIKE 'issue_%'
             OR p.proname LIKE 'fn_credit_%'
             OR p.proname LIKE 'fn_debit_%'
             OR p.proname LIKE 'fn_add_%'
             OR p.proname LIKE 'fn_pay_%'
             OR p.proname LIKE 'fn_atomic_%'
             OR p.proname LIKE 'fn_purchase_%'
             OR p.proname LIKE 'fn_transfer_%'
             OR p.proname LIKE 'fn_union_%'
             OR p.proname LIKE 'fn_clawback_%'
             OR p.proname LIKE 'fn_approve_cashout%'
             OR p.proname LIKE 'fn_reject_cashout%'
             OR p.proname LIKE 'fn_complete_cashout%'
             OR p.proname LIKE 'fn_request_cashout%'
             OR p.proname LIKE 'fn_cancel_cashout%'
             OR p.proname LIKE 'fn_agent_approve_cashout%'
             OR p.proname LIKE 'fn_grant_%'
             OR p.proname LIKE 'fn_consume_%'
             OR p.proname LIKE 'fn_leave_club%'
             OR p.proname LIKE 'fn_leave_table%'
             OR p.proname LIKE 'fn_seat_player%'
             OR p.proname LIKE 'fn_send_message%'
             OR p.proname LIKE 'fn_create_%'
             OR p.proname LIKE 'fn_delete_message%'
             OR p.proname LIKE 'fn_update_%'
             OR p.proname LIKE 'fn_save_player_note%'
             OR p.proname LIKE 'fn_toggle_message_reaction%'
             OR p.proname LIKE 'fn_complete_media_upload%'
             OR p.proname LIKE 'fn_mark_messages_read%'
             OR p.proname LIKE 'fn_remove_friend%'
             OR p.proname LIKE 'fn_accept_friend%'
             OR p.proname LIKE 'fn_award_%'
             OR p.proname LIKE 'fn_submit_bug_report%'
             OR p.proname LIKE 'lock_chips%'
             OR p.proname LIKE 'unlock_chips%'
             OR p.proname LIKE 'unlock_achievement%'
             OR p.proname LIKE 'update_achievement%'
             OR p.proname LIKE 'update_bankroll%'
             OR p.proname LIKE 'update_daily_streak%'
             OR p.proname LIKE 'update_login_streak%'
             OR p.proname LIKE 'update_player_hand_stats%'
             OR p.proname LIKE 'update_leaderboard%'
             -- Tournament + arcade
             OR p.proname LIKE 'register_for_tournament%'
             OR p.proname LIKE 'process_tournament_%'
             OR p.proname LIKE 'sync_tournament_%'
             OR p.proname LIKE 'balance_tournament_%'
             OR p.proname LIKE 'distribute_tournament_%'
             OR p.proname LIKE 'record_tournament_%'
             OR p.proname LIKE 'increment_tournament_%'
             OR p.proname LIKE 'update_tournament_%'
             OR p.proname LIKE 'complete_arcade_%'
             OR p.proname LIKE 'record_arena_%'
             OR p.proname LIKE 'complete_daily_challenge%'
             OR p.proname LIKE 'complete_hand_snapshot%'
             OR p.proname LIKE 'sync_tournament%'
             -- Counters that affect visible state
             OR p.proname LIKE 'increment_agent_rake%'
             OR p.proname LIKE 'increment_club_rake%'
             OR p.proname LIKE 'increment_rake_%'
             OR p.proname LIKE 'increment_union_%'
             OR p.proname LIKE 'increment_club_chip%'
             OR p.proname LIKE 'increment_club_table%'
             OR p.proname LIKE 'increment_diamonds%'
             OR p.proname LIKE 'increment_home_game_stats%'
             OR p.proname LIKE 'increment_member_count%'
             OR p.proname LIKE 'increment_post_count%'
             OR p.proname LIKE 'increment_share_count%'
             OR p.proname LIKE 'increment_story_view%'
             OR p.proname LIKE 'increment_table_hands%'
             OR p.proname LIKE 'decrement_%'
             OR p.proname LIKE 'decrement_member_count%'
             OR p.proname LIKE 'decrement_post_count%'
             -- Horse / table ops
             OR p.proname LIKE 'seat_horse%'
             OR p.proname LIKE 'remove_horse%'
             OR p.proname LIKE 'schedule_horse_leave%'
             OR p.proname LIKE 'mass_fund_horses%'
             OR p.proname LIKE 'close_table_session%'
             OR p.proname LIKE 'join_waitlist%'
             OR p.proname LIKE 'player_leave_table%'
             OR p.proname LIKE 'promote_next_waitlisted%'
             OR p.proname LIKE 'promote_member%'
             OR p.proname LIKE 'recompute_club_levels%'
             OR p.proname LIKE 'recompute_union_levels%'
             OR p.proname LIKE 'recalculate_leaderboard%'
             -- BBJ + promo + spin + records
             OR p.proname LIKE 'bbj_record_contribution%'
             OR p.proname LIKE 'add_bbj_contribution%'
             OR p.proname LIKE 'generate_period_%'
             OR p.proname LIKE 'generate_period_commissions%'
             OR p.proname LIKE 'generate_period_settlement%'
             OR p.proname LIKE 'calculate_agent_%'
             OR p.proname LIKE 'calculate_cascading_commission%'
             OR p.proname LIKE 'spin_pool_%'
             OR p.proname LIKE 'record_rake%'
             OR p.proname LIKE 'record_hand_rake%'
             OR p.proname LIKE 'record_insurance%'
             OR p.proname LIKE 'record_promo_wagering%'
             OR p.proname LIKE 'record_table_cashout%'
             OR p.proname LIKE 'redeem_promo%'
             OR p.proname LIKE 'execute_commission%'
             OR p.proname LIKE 'execute_pot_drops%'
             OR p.proname LIKE 'verify_and_log_union_%'
             OR p.proname LIKE 'orb1_buyin_transaction%'
             -- Profile / activity / tracking
             OR p.proname LIKE 'set_active_avatar%'
             OR p.proname LIKE 'dismiss_celebration%'
             OR p.proname LIKE 'initialize_player_profile%'
             OR p.proname LIKE 'track_home_group_%'
             OR p.proname LIKE 'track_training_%'
             OR p.proname LIKE 'revive_home_group%'
             OR p.proname LIKE 'save_hand_state_snapshot%'
             OR p.proname LIKE 'insert_hole_cards%'
             OR p.proname LIKE 'update_friend_preferences%'
             OR p.proname LIKE 'update_messenger_preferences%'
             OR p.proname LIKE 'update_reels_preferences%'
             OR p.proname LIKE 'update_store_preferences%'
             OR p.proname LIKE 'update_session_after_hand%'
             OR p.proname LIKE 'update_table_stats%'
             OR p.proname LIKE 'log_audit_event%'
             OR p.proname LIKE 'log_wallet_transaction%'
             OR p.proname LIKE 'report_live_game%'
             OR p.proname LIKE 'increment_bonus_progress%'
             OR p.proname LIKE 'increment_sandbox_count%'
             OR p.proname LIKE 'increment_settlement_counters%'
             OR p.proname LIKE 'increment_cache_served%'
             OR p.proname LIKE 'increment_column%'
             OR p.proname LIKE 'increment_news_views%'
             OR p.proname LIKE 'increment_share_view%'
             OR p.proname LIKE 'publish_scheduled_content%'
             OR p.proname LIKE 'transfer_club_ownership%'
             OR p.proname LIKE 'transfer_diamonds_%'
             OR p.proname LIKE 'activate_vip%'
           )
           -- Only where anon or authenticated currently has EXECUTE
           AND (has_function_privilege('anon', p.oid, 'EXECUTE') 
                OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
           -- Don't touch the explicitly-audited Phase 29/30/31 unified RPCs
           AND p.proname NOT IN (
               'submit_venue_claim_request','approve_venue_claim','reject_venue_claim',
               'get_venue_claim_queue','get_unified_user_profile','get_unified_user_activity',
               'get_user_cross_product_summary','search_unified_entities',
               'get_platform_integrity_report','submit_venue_review',
               'checkin_to_venue','follow_venue','unfollow_venue','get_my_followed_venues',
               'toggle_venue_review_helpful','flag_venue_review','resolve_review_flag'
           )
    LOOP
        v_signature := 'public.' || quote_ident(r.proname) || '(' || r.args || ')';
        BEGIN
            EXECUTE 'REVOKE EXECUTE ON FUNCTION ' || v_signature || ' FROM PUBLIC, anon, authenticated';
            EXECUTE 'GRANT EXECUTE ON FUNCTION ' || v_signature || ' TO service_role';
            v_revoked := v_revoked + 1;
        EXCEPTION WHEN OTHERS THEN
            v_skipped := v_skipped + 1;
            RAISE WARNING 'Skipped %: %', v_signature, SQLERRM;
        END;
    END LOOP;
    RAISE NOTICE 'Phase 32 revoke complete: locked=%, skipped=%', v_revoked, v_skipped;
END $$;
