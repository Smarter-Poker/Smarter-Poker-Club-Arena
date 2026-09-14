-- Validate newly written MTT structures at the common storage boundary.
-- No existing row is updated, and unrelated writes retain historical contracts.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.fn_ca_blind_contract_number(p_value jsonb)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path=public,pg_temp AS $function$
DECLARE v numeric; t text:=p_value #>> '{}';
BEGIN
  IF jsonb_typeof(p_value) NOT IN ('number','string') OR t !~ '^[0-9]+([.][0-9]+)?$' THEN RETURN NULL; END IF;
  v:=t::numeric;
  IF v>9007199254740991 THEN RETURN NULL; END IF;
  RETURN v;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_blind_contract_number(jsonb) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_mtt_blind_contract(p_structure text,p_starting_chips integer)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
SET search_path=public,pg_temp AS $function$
DECLARE
  levels jsonb; r jsonb; i integer:=0; played integer:=0;
  sb numeric; bb numeric; ante numeric; mins numeric; secs numeric; opening numeric;
  previous_sb numeric:=-1; previous_bb numeric:=-1; speed text;
BEGIN
  IF p_starting_chips IS NULL OR p_starting_chips<=0 THEN
    RAISE EXCEPTION 'Invalid tournament blind structure: starting stack must be a positive whole number' USING ERRCODE='22023';
  END IF;
  BEGIN levels:=p_structure::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Invalid tournament blind structure: unreadable ladder' USING ERRCODE='22023';
  END;
  IF levels IS NULL OR jsonb_typeof(levels)<>'array' THEN
    RAISE EXCEPTION 'Invalid tournament blind structure: at least one playable level is required' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(levels)=0 THEN
    RAISE EXCEPTION 'Invalid tournament blind structure: at least one playable level is required' USING ERRCODE='22023';
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(levels) LOOP
    i:=i+1;
    IF jsonb_typeof(r)<>'object' THEN
      RAISE EXCEPTION 'Invalid tournament blind structure: level % must be an object',i USING ERRCODE='22023';
    END IF;
    IF r ? 'isBreak' AND jsonb_typeof(r->'isBreak')<>'boolean' THEN
      RAISE EXCEPTION 'Invalid tournament blind structure: level % has an invalid break flag',i USING ERRCODE='22023';
    END IF;
    mins:=public.fn_ca_blind_contract_number(COALESCE(NULLIF(r->'durationMinutes','null'::jsonb),r->'duration_minutes'));
    secs:=public.fn_ca_blind_contract_number(r->'duration');
    IF COALESCE(mins,0)<=0 AND COALESCE(secs,0)<=0 THEN
      RAISE EXCEPTION 'Invalid tournament blind structure: level % needs a positive duration',i USING ERRCODE='22023';
    END IF;
    sb:=public.fn_ca_blind_contract_number(r->'smallBlind');
    bb:=public.fn_ca_blind_contract_number(r->'bigBlind');
    ante:=CASE WHEN r ? 'ante' THEN public.fn_ca_blind_contract_number(r->'ante') ELSE 0 END;
    IF sb IS NULL OR bb IS NULL OR ante IS NULL THEN
      RAISE EXCEPTION 'Invalid tournament blind structure: level % has invalid blinds or ante',i USING ERRCODE='22023';
    END IF;
    IF r->'isBreak'='true'::jsonb THEN
      IF i=1 OR sb<>0 OR bb<>0 OR ante<>0 THEN
        RAISE EXCEPTION 'Invalid tournament blind structure: level % is not a valid break',i USING ERRCODE='22023';
      END IF;
      CONTINUE;
    END IF;
    IF bb<=0 OR sb>bb THEN
      RAISE EXCEPTION 'Invalid tournament blind structure: level % needs a positive big blind at least as large as its small blind',i USING ERRCODE='22023';
    END IF;
    IF sb<previous_sb OR bb<previous_bb THEN
      RAISE EXCEPTION 'Invalid tournament blind structure: level % decreases the blinds',i USING ERRCODE='22023';
    END IF;
    IF played=0 THEN opening:=CASE WHEN mins>0 THEN mins ELSE secs/60 END; END IF;
    previous_sb:=sb; previous_bb:=bb; played:=played+1;
  END LOOP;
  IF played=0 THEN
    RAISE EXCEPTION 'Invalid tournament blind structure: at least one playable level is required' USING ERRCODE='22023';
  END IF;
  speed:=CASE WHEN opening<=2 THEN 'hyper_turbo' WHEN opening<=5 THEN 'turbo' WHEN opening>=12 THEN 'slow' ELSE 'standard' END;
  RETURN jsonb_build_object('blind_speed',speed,'is_turbo',speed IN ('turbo','hyper_turbo'));
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_mtt_blind_contract(text,integer) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.fn_guard_new_mtt_blind_contract()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $function$
DECLARE contract jsonb;
BEGIN
  IF upper(COALESCE(NEW.tournament_type,''))<>'MTT'
     OR lower(COALESCE(NEW.variant,'')) IN ('spin','sng')
     OR COALESCE(NEW.max_players,0)<=2 THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.blind_structure IS NOT DISTINCT FROM OLD.blind_structure
     AND NEW.starting_chips IS NOT DISTINCT FROM OLD.starting_chips
     AND upper(COALESCE(OLD.tournament_type,''))='MTT'
     AND lower(COALESCE(OLD.variant,'')) NOT IN ('spin','sng')
     AND COALESCE(OLD.max_players,0)>2 THEN RETURN NEW; END IF;
  contract:=public.fn_ca_mtt_blind_contract(NEW.blind_structure,NEW.starting_chips);
  NEW.blind_speed:=contract->>'blind_speed';
  NEW.is_turbo:=(contract->>'is_turbo')::boolean;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_guard_new_mtt_blind_contract() FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS tournaments_new_mtt_blind_contract ON public.tournaments;
CREATE TRIGGER tournaments_new_mtt_blind_contract
BEFORE INSERT OR UPDATE OF blind_structure,starting_chips,tournament_type,variant,max_players ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_new_mtt_blind_contract();
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
VALUES('tournaments','tournaments_new_mtt_blind_contract',
 'Validate newly written MTT blind ladders and starting stacks, and derive speed from their actual opening clock; preserve unchanged historical contracts.')
ON CONFLICT(table_name,trigger_name) DO UPDATE SET note=excluded.note;
COMMIT;
