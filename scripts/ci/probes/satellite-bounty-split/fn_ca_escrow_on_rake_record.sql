CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_rake_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_fee numeric := round(COALESCE(NEW.rake_amount,0),2);
BEGIN
  IF NOT COALESCE(NEW.is_tournament,false) OR NEW.tournament_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_fee < 0 AND NEW.source IN (
       'atomic_cancel_tournament',
       'fn_unregister_from_tournament') THEN
    RETURN NULL;
  END IF;
  IF NEW.source = 'fn_award_satellite_seat' THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.tournament_id,'satellite seat fee',
      p_satellite_fee_in => v_fee,
      -- Version 2 transfer gross already excludes its fee; legacy gross does not.
      p_satellite_in => CASE WHEN NEW.metadata->>'entry_split_version'='2'
                            THEN 0 ELSE -v_fee END);
  ELSE
    PERFORM public.fn_ca_escrow_apply(
      NEW.tournament_id,'entry fee',p_fee_entries_in => v_fee);
  END IF;
  RETURN NULL;
END;
$function$
