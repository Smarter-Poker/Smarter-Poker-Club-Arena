CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_seat_payout()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.fn_ca_escrow_apply(NEW.tournament_id, 'satellite seat out', p_prize_out => round(COALESCE(NEW.amount, 0), 2));
  RETURN NULL;
END;
$function$
