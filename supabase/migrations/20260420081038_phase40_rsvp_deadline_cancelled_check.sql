-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420081038 "phase40_rsvp_deadline_cancelled_check"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cb604aa811a0fe2aac2d660b841fe81c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- phase40_rsvp_deadline_cancelled_check
--
-- Extend fn_enforce_rsvp_deadline to also reject RSVPs on cancelled games.
-- The rsvp_to_home_game RPC already checks this (raises GAME_NOT_OPEN_FOR_RSVP
-- for status='cancelled'), but an authenticated client can bypass the RPC and
-- INSERT directly into commander_home_rsvps (RLS allows it for group members).
-- The trigger closes that gap as defense-in-depth.
--
-- Keeps the existing auth.uid() IS NULL bypass so cron/trigger paths (which
-- don't have a JWT) still work.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_enforce_rsvp_deadline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_game RECORD;
BEGIN
    IF auth.uid() IS NULL THEN RETURN NEW; END IF;  -- service bypass (cron/trigger)

    SELECT rsvps_closed, rsvp_closes_at, status, scheduled_date, start_time
      INTO v_game
      FROM commander_home_games WHERE id = NEW.game_id;
    IF NOT FOUND THEN RETURN NEW; END IF;

    -- Reject RSVPs on cancelled games (matches rsvp_to_home_game RPC behaviour).
    IF v_game.status = 'cancelled' THEN
        RAISE EXCEPTION 'GAME_CANCELLED'
              USING HINT = 'cannot RSVP to a cancelled game';
    END IF;

    -- Reject RSVPs on non-RSVPable statuses.
    IF v_game.status IS NOT NULL
       AND v_game.status NOT IN ('scheduled','confirmed','in_progress','completed') THEN
        RAISE EXCEPTION 'GAME_NOT_OPEN_FOR_RSVP'
              USING HINT = 'game status is ' || v_game.status;
    END IF;

    IF v_game.rsvps_closed = true THEN
        RAISE EXCEPTION 'RSVPS_CLOSED' USING HINT='host has closed RSVPs for this game';
    END IF;

    IF v_game.rsvp_closes_at IS NOT NULL AND v_game.rsvp_closes_at < NOW() THEN
        RAISE EXCEPTION 'RSVP_DEADLINE_PASSED'
              USING HINT='RSVP deadline was ' || v_game.rsvp_closes_at::text;
    END IF;

    RETURN NEW;
END; $function$;
