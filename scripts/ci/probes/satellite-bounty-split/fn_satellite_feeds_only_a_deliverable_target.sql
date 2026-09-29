CREATE OR REPLACE FUNCTION public.fn_satellite_feeds_only_a_deliverable_target()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_target uuid := COALESCE(NEW.satellite_target_id, NEW.satellite_target);
  v_old_target uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old_target := COALESCE(OLD.satellite_target_id, OLD.satellite_target);
  END IF;

  -- A satellite may only be opened into, or re-pointed at, a target whose
  -- seat the settlement authority can deliver.
  IF v_target IS NOT NULL
     AND (TG_OP = 'INSERT' OR v_target IS DISTINCT FROM v_old_target)
     AND NOT public.fn_satellite_target_is_deliverable(v_target) THEN
    RAISE EXCEPTION
      'satellite % cannot feed target %: the satellite settlement authority refuses a bounty, PKO, mystery-bounty or Spin entry split',
      NEW.id, v_target
      USING ERRCODE = '22023',
            HINT = 'Pick a target whose entry is a plain buy-in plus fee.';
  END IF;

  -- A tournament live satellites feed may not become one that refuses them.
  IF TG_OP = 'UPDATE'
     AND (NEW.is_bounty, NEW.is_pko, NEW.is_mystery_bounty, NEW.is_premium_spin,
          NEW.variant, NEW.tournament_type)
         IS DISTINCT FROM
         (OLD.is_bounty, OLD.is_pko, OLD.is_mystery_bounty, OLD.is_premium_spin,
          OLD.variant, OLD.tournament_type)
     AND NOT (NEW.is_bounty IS FALSE AND NEW.is_pko IS FALSE
              AND NEW.is_mystery_bounty IS FALSE AND NEW.is_premium_spin IS FALSE
              AND lower(COALESCE(NEW.variant, '')) <> 'spin'
              AND upper(COALESCE(NEW.tournament_type, '')) <> 'SPIN')
     AND EXISTS (
       SELECT 1 FROM public.tournaments s
        WHERE COALESCE(s.satellite_target_id, s.satellite_target) = NEW.id
          AND s.id <> NEW.id
          AND upper(COALESCE(s.status, '')) NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
     ) THEN
    RAISE EXCEPTION
      'tournament % is fed by a live satellite and cannot take a bounty, PKO, mystery-bounty or Spin entry split',
      NEW.id
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$function$

