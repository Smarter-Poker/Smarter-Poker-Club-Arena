CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_seat_transfer_leg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.metadata->>'entry_split_version' = '2' THEN
    IF round(NEW.amount,2) IS DISTINCT FROM round((NEW.metadata->>'entry_prize')::numeric
        + (NEW.metadata->>'entry_bounty')::numeric + (NEW.metadata->>'entry_fee')::numeric,2)
       OR (NEW.metadata->>'entry_prize')::numeric < 0
       OR (NEW.metadata->>'entry_bounty')::numeric < 0
       OR (NEW.metadata->>'entry_fee')::numeric < 0 THEN
      RAISE EXCEPTION 'Satellite transfer does not match its funded split' USING ERRCODE='23514';
    END IF;
    PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'satellite split entry',
      p_gross_in => round(NEW.amount - (NEW.metadata->>'entry_fee')::numeric,2),
      p_bounty_in => (NEW.metadata->>'entry_bounty')::numeric);
    RETURN NULL;
  END IF;
  PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'satellite seat in', p_satellite_in => round(NEW.amount, 2));
  RETURN NULL;
END;
$function$
