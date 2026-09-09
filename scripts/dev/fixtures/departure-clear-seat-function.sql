-- Pinned read-only production function.
CREATE OR REPLACE FUNCTION public.fn_clear_table_seats(p_table_id uuid, p_reopen boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cleared integer := 0;
BEGIN
  /* PAY BEFORE RELEASING - same rule, same reason as the status-change
     trigger. This function cleared a table's seats outright, so any cash
     player still sitting lost their stack. No-ops for tournament tables. */
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
$function$
;
