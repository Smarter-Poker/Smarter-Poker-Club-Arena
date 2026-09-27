-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419215020 "phase32c_revoke_remaining_mutations"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 af7407999876921b0b93bd9e231f0bac of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 32C: Lock down remaining anon-callable state mutations
-- (cron jobs, admin tools, bot creation, counter mutators, etc.)
DO $$
DECLARE r RECORD; v_revoked int := 0; v_signature text;
BEGIN
    FOR r IN 
        SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' 
           AND p.prosecdef = true
           AND p.proname IN (
               -- Cron jobs (no-args, system-driven only)
               'auto_settle_completed_tournaments',
               'archive_old_arena_logs',
               'refresh_player_stats',
               'verify_ledger_totals',
               'cleanup_game_action_idempotency_keys',
               'cleanup_idempotency_keys','cleanup_old_hole_cards',
               'cleanup_old_table_chat','cleanup_rate_limits',
               -- Admin / anti-cheat tools
               'detect_collusion_pairs','detect_suspicious_plays',
               'analyze_spots_by_game_type',
               -- State mutations
               'create_bot_player',
               'fn_bump_home_group_activity','fn_home_group_sync_venue',
               'fn_increment_club_member_count','fn_release_tournament_holds',
               'fn_view_story',
               'reserve_clip','reserve_sports_clip',
               'set_topic_cooldown','recalculate_venue_trust_score',
               'record_health_metric','record_horse_memory',
               'geeves_increment_missed_count','geeves_upsert_missed_question',
               -- Cron locking helpers (service-role-only by design)
               'fn_try_cron_lock','fn_release_cron_lock'
           )
           AND (has_function_privilege('anon', p.oid, 'EXECUTE') 
                OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    LOOP
        v_signature := 'public.' || quote_ident(r.proname) || '(' || r.args || ')';
        BEGIN
            EXECUTE 'REVOKE EXECUTE ON FUNCTION ' || v_signature || ' FROM PUBLIC, anon, authenticated';
            EXECUTE 'GRANT EXECUTE ON FUNCTION ' || v_signature || ' TO service_role';
            v_revoked := v_revoked + 1;
        EXCEPTION WHEN OTHERS THEN NULL; END;
    END LOOP;
    RAISE NOTICE 'Phase 32C locked down % additional functions', v_revoked;
END $$;
