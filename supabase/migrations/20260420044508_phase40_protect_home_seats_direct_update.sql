-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420044508 "phase40_protect_home_seats_direct_update"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0fff2874d89505790e60ecd5332cca73 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 50: commander_home_seats UPDATE policy has no WITH CHECK
-- and permits any seat-holder to mutate their own row. Direct UPDATE bypasses
-- all seat-management RPC invariants:
--
--   - Alice UPDATE seat_number=N → seat-hop to any empty seat, bypassing
--     max_players validation and the fn_home_move_seat staff-only check
--   - Alice UPDATE status='empty' / away → bypass release RPC, create
--     orphaned rows
--   - Alice UPDATE seated_at to backdate attendance
--
-- Ban hijack attack was already blocked incidentally: post-UPDATE USING-as-
-- WITH-CHECK rejected user_id=Bob because Alice is not Bob and not staff.
--
-- Fix: all seat writes must go through the SECURITY DEFINER RPCs
-- (claim/release/assign/mark_away/fn_home_move_seat/etc) which run as
-- `postgres`. Block any UPDATE where current_user is a client role.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_block_direct_home_seat_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
    -- Allow if running inside a SECURITY DEFINER RPC (current_user switched to owner)
    -- Block if current_user is a client role (direct PostgREST UPDATE)
    IF current_user IN ('authenticated', 'anon') THEN
      RAISE EXCEPTION 'DIRECT_SEAT_UPDATE_FORBIDDEN'
            USING HINT = 'use claim_home_game_seat / release_own_home_game_seat / '
                       || 'assign_home_game_seat / mark_home_game_seat_away / '
                       || 'fn_home_move_seat instead of direct UPDATE';
    END IF;

    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_block_direct_home_seat_update
  ON public.commander_home_seats;
CREATE TRIGGER trg_block_direct_home_seat_update
BEFORE UPDATE ON public.commander_home_seats
FOR EACH ROW
EXECUTE FUNCTION public.fn_block_direct_home_seat_update();

COMMENT ON FUNCTION public.fn_block_direct_home_seat_update IS
  'Phase 40 Bug 50: blocks direct-UPDATE seat mutations by client roles '
  '(authenticated/anon). SECURITY DEFINER RPCs run as postgres and pass.';
