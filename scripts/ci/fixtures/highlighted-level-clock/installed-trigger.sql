CREATE OR REPLACE FUNCTION public.fn_ca_tournament_lock_level_clock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  authored jsonb;
  locked jsonb;
  m integer;
  derived boolean := false;
BEGIN
  IF upper(COALESCE(NEW.tournament_type, '')) NOT IN ('MTT', 'SATELLITE')
     OR lower(COALESCE(NEW.variant, '')) IN ('spin', 'sng') THEN
    RETURN NEW;
  END IF;
  -- A started event keeps the clock its players are already playing.
  IF TG_OP = 'UPDATE' AND upper(COALESCE(NEW.status, ''))
       NOT IN ('REGISTERING', 'ANNOUNCED', 'SCHEDULED', 'PENDING') THEN
    RETURN NEW;
  END IF;
  BEGIN
    authored := NEW.blind_structure::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NEW; -- unreadable ladders are refused by the blind contract trigger
  END;
  IF authored IS NULL OR jsonb_typeof(authored) <> 'array' OR jsonb_array_length(authored) = 0 THEN
    RETURN NEW;
  END IF;

  m := public.fn_ca_locked_level_minutes(
    NEW.name,
    CASE WHEN NEW.buy_in_amount IS NULL THEN NULL
         ELSE NEW.buy_in_amount + COALESCE(NEW.buy_in_fee, 0) END,
    COALESCE(NEW.is_bounty, false) OR COALESCE(NEW.is_pko, false)
      OR COALESCE(NEW.is_mystery_bounty, false) OR COALESCE(NEW.bounty_amount, 0) > 0
      OR lower(COALESCE(NEW.variant, '')) IN ('bounty', 'progressive_bounty', 'mystery_bounty'),
    upper(COALESCE(NEW.tournament_type, '')) = 'SATELLITE'
      OR lower(COALESCE(NEW.variant, '')) = 'satellite',
    authored);
  locked := public.fn_ca_lock_structure_clock(authored, m);

  IF locked IS DISTINCT FROM authored THEN
    IF COALESCE(NEW.late_reg_levels, 0) > 0 THEN
      BEGIN
        derived := NEW.late_reg_mins = public.fn_ca_mtt_late_registration_minutes(authored, NEW.late_reg_levels);
      EXCEPTION WHEN OTHERS THEN
        derived := false;
      END;
      IF derived THEN
        NEW.late_reg_mins := public.fn_ca_mtt_late_registration_minutes(locked, NEW.late_reg_levels);
      END IF;
    END IF;
    NEW.blind_structure := locked::text;
  END IF;

  -- Free Buy: one hour of late registration on the 5-minute clock.
  IF upper(COALESCE(NEW.tournament_type, '')) = 'MTT'
     AND lower(COALESCE(NEW.name, '')) ~ 'free ?buy'
     AND COALESCE(NEW.buy_in_amount, 0) + COALESCE(NEW.buy_in_fee, 0) = 0
     AND m = 5
     AND COALESCE(NEW.late_reg_levels, 0) > 0
     AND (NEW.late_reg_levels, NEW.late_reg_mins) IS DISTINCT FROM (12, 60) THEN
    IF NEW.rebuy_levels IS NOT DISTINCT FROM NEW.late_reg_levels THEN
      NEW.rebuy_levels := 12;
    END IF;
    NEW.late_reg_levels := 12;
    NEW.late_reg_mins := 60;
  END IF;
  RETURN NEW;
END;
$function$
