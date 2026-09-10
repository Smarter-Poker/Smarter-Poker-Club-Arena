CREATE OR REPLACE FUNCTION public.fn_clear_seats_on_game_end()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_table uuid;
BEGIN
  IF NEW.status IN ('COMPLETED', 'CANCELLED')
     AND COALESCE(OLD.status, '') IS DISTINCT FROM NEW.status THEN
    FOR v_table IN
      SELECT id FROM public.tables WHERE tournament_id = NEW.id
    LOOP
      -- Never reopen a table whose game is over: the recycler builds the next
      -- spin its own fresh table. What must not survive is the seat rows.
      PERFORM public.fn_clear_table_seats(v_table, false);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_clear_table_seats(p_table_id uuid, p_reopen boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cleared integer := 0;
  v_tournament uuid;
BEGIN
  SELECT tournament_id INTO v_tournament FROM public.tables WHERE id=p_table_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Table not found' USING ERRCODE='22023'; END IF;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'CASH_SEAT_CLEAR_REQUIRES_ENGINE_DEPARTURES' USING ERRCODE='55000';
  END IF;
  -- Only tournament cleanup reaches this point. Cash departures are engine-owned.
  PERFORM public.fn_cashout_seats_for_closing_table(p_table_id, 'seats cleared');

  UPDATE public.table_seats
     SET left_at = now(), is_sitting_out = false
   WHERE table_id = p_table_id AND left_at IS NULL;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  UPDATE public.tables
     SET current_players = 0,
         status = CASE WHEN p_reopen AND status <> 'closed' THEN 'waiting' ELSE status END
   WHERE id = p_table_id;

  RETURN v_cleared;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_release_seats_on_tournament_finish()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only on the TRANSITION into a finished state. Firing on every update of an
  -- already-finished row would rewrite left_at timestamps that are correct.
  IF NEW.status IN ('COMPLETED','CANCELLED')
     AND (OLD.status IS DISTINCT FROM NEW.status) THEN

    UPDATE table_seats ts
       SET left_at = COALESCE(NEW.ended_at, now())
      FROM tables t
     WHERE ts.table_id = t.id
       AND t.tournament_id = NEW.id
       AND ts.left_at IS NULL;

  END IF;
  RETURN NEW;
END;
$function$;