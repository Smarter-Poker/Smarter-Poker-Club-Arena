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

  -- Once under way, entrants are counted by their SEATS and the seat trigger
  -- owns the rule. An unreadable tournament row is checked, not waved through.
  IF v_tstatus IS NOT NULL AND v_tstatus NOT IN ('ANNOUNCED', 'REGISTERING') THEN
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
$function$
