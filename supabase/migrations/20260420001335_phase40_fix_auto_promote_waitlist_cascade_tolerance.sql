-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420001335 "phase40_fix_auto_promote_waitlist_cascade_tolerance"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 27f883073f2c435b51acd1dfe822b847 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 / new bug found during sibling-hardening migration:
--
-- fn_auto_promote_waitlist fires on RSVP delete; when it's a cascade delete
-- (game was just deleted, triggering CASCADE on its RSVPs), the game row is
-- already gone. The inner call to promote_home_game_waitlist then raises
-- GAME_NOT_FOUND, which aborts the entire transaction.
--
-- Impact: deleting a home game with any 'yes' RSVPs was impossible.
--
-- Fix: the trigger silently skips promotion when the parent game no longer
-- exists, AND wraps the inner call in EXCEPTION so any other anomaly in
-- the waitlist-promote path cannot block an RSVP delete either.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_auto_promote_waitlist()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_target_game_id uuid;
    v_game_exists boolean;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.response = 'yes' AND NEW.response <> 'yes' THEN
        v_target_game_id := NEW.game_id;
    ELSIF TG_OP = 'DELETE' AND OLD.response = 'yes' THEN
        v_target_game_id := OLD.game_id;
    ELSE
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Guard: skip if the parent game has already been deleted in this TX
    -- (the typical cascade path). Without this check, promote_home_game_waitlist
    -- raises GAME_NOT_FOUND and aborts the whole cascade.
    SELECT EXISTS(SELECT 1 FROM commander_home_games WHERE id = v_target_game_id)
      INTO v_game_exists;
    IF NOT v_game_exists THEN
      RETURN COALESCE(NEW, OLD);
    END IF;

    -- Defensive wrapper: any failure inside the promote path (e.g. status
    -- changed mid-transaction) should not block the underlying RSVP mutation.
    -- Waitlist promotion is an opportunistic side effect, not a required one.
    BEGIN
      PERFORM public.promote_home_game_waitlist(v_target_game_id, NULL);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'fn_auto_promote_waitlist swallowed promote error for game %: % (%)',
        v_target_game_id, SQLERRM, SQLSTATE;
    END;

    RETURN COALESCE(NEW, OLD);
END;
$function$;

COMMENT ON FUNCTION public.fn_auto_promote_waitlist IS
  'Phase 40: fires on RSVP delete/update-from-yes to promote waitlist. '
  'Tolerates parent-game-already-deleted (cascade) and swallows any '
  'downstream promotion errors so the underlying RSVP mutation always '
  'succeeds. Waitlist promotion is opportunistic.';
