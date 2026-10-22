-- SUPERSEDED BY 20261021222049: never installed. Owner 2026-10-21 locked every MTT and satellite level to one fixed clock (turbos and freerolls 5 min, standard and bounty 8, deep stack 10) and excluded Spins and Sit & Gos; 20261021222049_lock_tournament_level_clocks implements that and is live. This file would also have forced Spin levels up to 300 s, against that rule.
-- 20261021173101_tournament_levels_have_a_five_minute_floor
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-21 17:31:01 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
-- Owner October 21: no playable tournament level below five minutes;
-- standard MTTs use eight to ten minute levels. Legacy seconds and both minute
-- spellings are normalized together. Only clocks change, never stakes or prizes.
-- ROLLOUT DEPENDENCY: activate the engine's playable legacy Spin projection
-- before installing this migration. Older engines compare booked 180-second
-- receipts exactly against this trigger's 300-second projection and refuse launch.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='20s';
CREATE FUNCTION public.fn_ca_minimum_tournament_levels(p_structure text,p_floor numeric DEFAULT 5)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $fn$
DECLARE v_levels jsonb; v_level jsonb; v_result jsonb:='[]'; v_minutes numeric; v_changed boolean:=false;
BEGIN
 IF p_structure IS NULL OR btrim(p_structure)='' THEN RETURN p_structure; END IF;
 v_levels:=p_structure::jsonb;
 IF jsonb_typeof(v_levels)<>'array' THEN RAISE EXCEPTION 'Blind Structure Must Be An Array'; END IF;
 FOR v_level IN SELECT value FROM jsonb_array_elements(v_levels) LOOP
  IF jsonb_typeof(v_level)<>'object' THEN RAISE EXCEPTION 'Every Blind Level Must Be An Object'; END IF;
  IF NOT coalesce((v_level->>'isBreak')::boolean,false) THEN
   v_minutes:=coalesce(nullif((v_level->>'durationMinutes')::numeric,0),nullif((v_level->>'duration_minutes')::numeric,0),nullif((v_level->>'duration')::numeric,0)/60);
   IF v_minutes>0 AND v_minutes<greatest(5,p_floor) THEN
    v_minutes:=greatest(5,p_floor);
    v_level:=jsonb_set(v_level,'{durationMinutes}',to_jsonb(v_minutes));
    IF v_level?'duration_minutes' THEN v_level:=jsonb_set(v_level,'{duration_minutes}',to_jsonb(v_minutes)); END IF;
    IF v_level?'duration' THEN v_level:=jsonb_set(v_level,'{duration}',to_jsonb(v_minutes*60)); END IF;
    v_changed:=true;
   END IF;
  END IF;
  v_result:=v_result||jsonb_build_array(v_level);
 END LOOP;
 RETURN CASE WHEN v_changed THEN v_result::text ELSE p_structure END;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_minimum_tournament_levels(text,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_minimum_tournament_levels(text,numeric) TO authenticated,service_role;

CREATE FUNCTION public.fn_ca_tournament_level_clock_floor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_floor numeric; v_structure text; v_count integer; v_last numeric;
BEGIN
 IF upper(coalesce(NEW.status,'')) IN ('COMPLETED','COMPLETING','CANCELLED','CANCELED','FAILED') THEN RETURN NEW; END IF;
 -- Ten raw minutes remain five after an old engine applies acceleration.
 v_floor:=CASE WHEN NEW.accelerated_mtt IS TRUE THEN 10
   WHEN upper(coalesce(NEW.tournament_type,''))='MTT' AND lower(coalesce(NEW.variant,'')) NOT IN ('spin','sng')
     AND lower(coalesce(NEW.blind_speed,'standard'))='standard' THEN 8 ELSE 5 END;
 v_structure:=public.fn_ca_minimum_tournament_levels(NEW.blind_structure,v_floor);
 IF v_structure IS DISTINCT FROM NEW.blind_structure
   OR TG_OP='INSERT' OR NEW.blind_structure IS DISTINCT FROM OLD.blind_structure THEN
  NEW.blind_structure:=v_structure;
  IF coalesce(NEW.late_reg_levels,0)>0 THEN
   SELECT jsonb_array_length(v_structure::jsonb), (array_agg(coalesce(nullif((e.value->>'durationMinutes')::numeric,0), nullif((e.value->>'duration_minutes')::numeric,0), (e.value->>'duration')::numeric/60) ORDER BY e.n DESC))[1]
   INTO v_count,v_last FROM jsonb_array_elements(v_structure::jsonb) WITH ORDINALITY e(value,n)
   WHERE NOT coalesce((e.value->>'isBreak')::boolean,false);
   SELECT ceil(greatest(0,NEW.late_reg_levels-coalesce(v_count,0))*coalesce(v_last,v_floor)+coalesce(sum(coalesce(nullif((e.value->>'durationMinutes')::numeric,0),
      nullif((e.value->>'duration_minutes')::numeric,0),(e.value->>'duration')::numeric/60)),0))::integer
   INTO NEW.late_reg_mins
   FROM jsonb_array_elements(v_structure::jsonb) WITH ORDINALITY e(value,n)
   WHERE e.n<=NEW.late_reg_levels AND NOT coalesce((e.value->>'isBreak')::boolean,false);
  END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_level_clock_floor() FROM PUBLIC,anon,authenticated,service_role;
-- Runs after the booked Spin projection, so its immutable draw remains intact
-- while the current timing rule is applied to the playable projection.
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
VALUES ('tournaments','zzzzzzzzzz_tournament_level_clock_floor',
'Reviewed October 21: applies only the owner minimum playable clock and its derived registration minutes. It moves no money and preserves stakes, prize values, booked Spin economics and terminal tournament history.')
ON CONFLICT(table_name,trigger_name) DO UPDATE SET note=EXCLUDED.note;
CREATE TRIGGER zzzzzzzzzz_tournament_level_clock_floor BEFORE INSERT OR UPDATE ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tournament_level_clock_floor();

CREATE FUNCTION public.fn_ca_schedule_level_clock_floor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_structure text; v_floor numeric;
BEGIN
 IF jsonb_typeof(NEW.config->'blindStructure')='array' THEN
  v_floor:=CASE WHEN coalesce((NEW.config->>'acceleratedMtt')::boolean,false) THEN 10
    WHEN upper(coalesce(NEW.config->>'blindPreset','STANDARD'))='STANDARD' THEN 8 ELSE 5 END;
  v_structure:=public.fn_ca_minimum_tournament_levels((NEW.config->'blindStructure')::text,v_floor);
  NEW.config:=jsonb_set(NEW.config,'{blindStructure}',v_structure::jsonb);
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_schedule_level_clock_floor() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER tournament_schedule_level_clock_floor BEFORE INSERT OR UPDATE OF config ON public.tournament_schedules
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_schedule_level_clock_floor();

UPDATE public.tournaments SET blind_structure=public.fn_ca_minimum_tournament_levels(blind_structure,
 CASE WHEN accelerated_mtt IS TRUE THEN 10 WHEN upper(coalesce(tournament_type,''))='MTT'
 AND lower(coalesce(variant,'')) NOT IN ('spin','sng') AND lower(coalesce(blind_speed,'standard'))='standard' THEN 8 ELSE 5 END)
WHERE upper(coalesce(status,'')) IN ('REGISTERING','RUNNING','STARTING','PAUSED','ANNOUNCED','LATE_REGISTRATION')
 AND blind_structure IS DISTINCT FROM public.fn_ca_minimum_tournament_levels(blind_structure,
 CASE WHEN accelerated_mtt IS TRUE THEN 10 WHEN upper(coalesce(tournament_type,''))='MTT'
 AND lower(coalesce(variant,'')) NOT IN ('spin','sng') AND lower(coalesce(blind_speed,'standard'))='standard' THEN 8 ELSE 5 END);
UPDATE public.tournament_schedules SET config=jsonb_set(config,'{blindStructure}',
 public.fn_ca_minimum_tournament_levels((config->'blindStructure')::text,
 CASE WHEN coalesce((config->>'acceleratedMtt')::boolean,false) THEN 10
 WHEN upper(coalesce(config->>'blindPreset','STANDARD'))='STANDARD' THEN 8 ELSE 5 END)::jsonb)
WHERE active AND jsonb_typeof(config->'blindStructure')='array'
 AND (config->'blindStructure')::text IS DISTINCT FROM public.fn_ca_minimum_tournament_levels((config->'blindStructure')::text,
 CASE WHEN coalesce((config->>'acceleratedMtt')::boolean,false) THEN 10
 WHEN upper(coalesce(config->>'blindPreset','STANDARD'))='STANDARD' THEN 8 ELSE 5 END);
COMMIT;
