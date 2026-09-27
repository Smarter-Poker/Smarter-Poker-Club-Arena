-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420044943 "phase40_fix_seat_lock_trigger_securitydefiner"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 19316f726ca4abfa86bdd70a960e8ca9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 50 fix correction: my trigger used SECURITY DEFINER, which
-- means current_user inside the trigger was always the function owner
-- (postgres), so the `current_user IN ('authenticated', 'anon')` check
-- never matched and no updates were blocked.
--
-- Remove SECURITY DEFINER: the trigger only needs to RAISE or RETURN NEW,
-- no privileged work. With SECURITY INVOKER (default), current_user reflects
-- the actual caller: 'authenticated' for direct UPDATE, 'postgres' for
-- SECURITY DEFINER RPCs.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_block_direct_home_seat_update()
RETURNS trigger
LANGUAGE plpgsql
-- no SECURITY DEFINER → default SECURITY INVOKER → current_user = caller
SET search_path TO 'public'
AS $fn$
BEGIN
    IF current_user IN ('authenticated', 'anon') THEN
      RAISE EXCEPTION 'DIRECT_SEAT_UPDATE_FORBIDDEN'
            USING HINT = 'use claim_home_game_seat / release_own_home_game_seat / '
                       || 'assign_home_game_seat / mark_home_game_seat_away / '
                       || 'fn_home_move_seat instead of direct UPDATE';
    END IF;
    RETURN NEW;
END;
$fn$;
