-- 20261026230116_late_tournament_registration_obeys_the_four_game_cap.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $preimage$
BEGIN
  IF md5(pg_get_functiondef('public.fn_enforce_booking_game_cap()'::regprocedure))
       <> '0770bebd2ce6924626f2c3c947d23038' THEN
    RAISE EXCEPTION 'booking cap source changed; review before installing';
  END IF;
END
$preimage$;
-- The former RUNNING bypass delegated to a seat trigger that intentionally
-- honours paid entries, allowing both guards to waive the same new entry.
-- Existing entries, seats, balances and scheduled bookings are preserved.
CREATE OR REPLACE FUNCTION public.fn_enforce_booking_game_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_load    int;
  v_tstatus text;
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS NULL OR NEW.status NOT IN ('registered', 'playing') THEN
    RETURN NEW;
  END IF;

  -- registered -> playing at late registration is not a NEW claim.
  IF TG_OP = 'UPDATE' AND OLD.status IN ('registered', 'playing') THEN
    RETURN NEW;
  END IF;

  SELECT tr.status INTO v_tstatus
    FROM public.tournaments tr
   WHERE tr.id = NEW.tournament_id;

  -- New late entrants have no paid chair yet. The seat trigger honours paid
  -- entries, so RUNNING admissions must be checked here before that promise.
  IF v_tstatus IS NOT NULL AND v_tstatus NOT IN ('ANNOUNCED', 'REGISTERING', 'RUNNING') THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || NEW.user_id::text, 0));

  v_load := public.fn_concurrent_game_load(NEW.user_id, NULL, NULL, NEW.tournament_id);

  IF v_load >= 4 THEN
    RAISE EXCEPTION
      'FOUR TABLE LIMIT: user % is already committed to % games and may not enter another',
      NEW.user_id, v_load
      USING ERRCODE = '23514',
            HINT = 'Leave a table or unregister before entering another. A game is a live seat or a booking for a tournament that has not started. This limit applies to players and horses alike.';
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;
