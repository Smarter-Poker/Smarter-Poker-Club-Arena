CREATE OR REPLACE FUNCTION public.fn_snapshot_daily_challenge_contract()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_replacement_tier text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT c.name, c.description, c.challenge_type, c.tier, c.requirement,
           c.threshold, c.chip_reward, c.diamond_reward
      INTO NEW.challenge_name_snapshot, NEW.challenge_description_snapshot,
           NEW.challenge_type_snapshot, NEW.tier_snapshot, NEW.requirement_snapshot,
           NEW.threshold_snapshot, NEW.chip_reward_snapshot, NEW.diamond_reward_snapshot
      FROM public.daily_challenge_catalog c
     WHERE c.id = NEW.challenge_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown challenge % - cannot snapshot its contract', NEW.challenge_id;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.challenge_id IS DISTINCT FROM OLD.challenge_id THEN
    IF current_setting('app.daily_challenge_reroll', true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'Assigned daily challenges can only be replaced by the reroll contract';
    END IF;
    IF OLD.completed OR OLD.claimed THEN
      RAISE EXCEPTION 'Completed daily challenge contracts cannot be replaced';
    END IF;
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.assigned_date IS DISTINCT FROM OLD.assigned_date
       OR NEW.id IS DISTINCT FROM OLD.id
    THEN
      RAISE EXCEPTION 'A reroll cannot move a daily challenge contract';
    END IF;

    SELECT c.name, c.description, c.challenge_type, c.tier, c.requirement,
           c.threshold, c.chip_reward, c.diamond_reward
      INTO NEW.challenge_name_snapshot, NEW.challenge_description_snapshot,
           NEW.challenge_type_snapshot, v_replacement_tier, NEW.requirement_snapshot,
           NEW.threshold_snapshot, NEW.chip_reward_snapshot, NEW.diamond_reward_snapshot
      FROM public.daily_challenge_catalog c
     WHERE c.id = NEW.challenge_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown replacement challenge %', NEW.challenge_id; END IF;
    IF v_replacement_tier IS DISTINCT FROM OLD.tier_snapshot THEN
      RAISE EXCEPTION 'A reroll cannot change mission cycle';
    END IF;
    NEW.tier_snapshot := v_replacement_tier;
    RETURN NEW;
  END IF;

  IF NEW.challenge_name_snapshot IS DISTINCT FROM OLD.challenge_name_snapshot
     OR NEW.challenge_description_snapshot IS DISTINCT FROM OLD.challenge_description_snapshot
     OR NEW.challenge_type_snapshot IS DISTINCT FROM OLD.challenge_type_snapshot
     OR NEW.tier_snapshot IS DISTINCT FROM OLD.tier_snapshot
     OR NEW.requirement_snapshot IS DISTINCT FROM OLD.requirement_snapshot
     OR NEW.threshold_snapshot IS DISTINCT FROM OLD.threshold_snapshot
     OR NEW.chip_reward_snapshot IS DISTINCT FROM OLD.chip_reward_snapshot
     OR NEW.diamond_reward_snapshot IS DISTINCT FROM OLD.diamond_reward_snapshot
  THEN
    RAISE EXCEPTION 'Assigned daily challenge contracts are immutable';
  END IF;
  RETURN NEW;
END;
$function$
