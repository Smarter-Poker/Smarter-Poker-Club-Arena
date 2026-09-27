-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419214918 "phase32b_revoke_missed_state_mutations"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 20cc7edcdddee755e2cc041dc94997ff of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 32B: Lock down state mutations missed by Phase 32 pattern filter.
-- These write to state but have names that didn't match the first sweep's
-- credit/debit/transfer/atomic/claim prefixes.
DO $$
DECLARE
    r RECORD;
    v_revoked int := 0;
    v_signature text;
BEGIN
    FOR r IN 
        SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' 
           AND p.prosecdef = true
           AND p.proname IN (
               -- Home game seat management (state mutations via p_caller)
               'fn_home_assign_seat','fn_home_init_seats','fn_home_move_seat',
               'fn_home_randomize_seats','fn_home_set_seat_status','fn_home_vacate_seat',
               -- Tournament registration (money + state)
               'fn_tournament_atomic_register','fn_tournament_register_counter',
               'fn_tournament_unregister_counter',
               -- Counter increments that affect visible state
               'fn_increment_agent_player_count','fn_increment_vip_usage',
               -- Achievements (writes to user's record)
               'check_bankroll_achievements',
               -- Arcade game sessions
               'start_arcade_game',
               -- Celebrations
               'dismiss_celebration',
               -- Waitlist/table state
               'fn_leave_table','fn_seat_player',
               -- Avatar/profile mutations
               'set_active_avatar',
               -- Presence
               'fn_update_presence'
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
    RAISE NOTICE 'Phase 32B revoked: % additional state mutations', v_revoked;
END $$;
