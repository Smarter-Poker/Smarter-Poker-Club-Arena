-- Dan, 2026-10-31: "KEEP DIAMOND ARENA CLOSED FOR NOW, DO NOT OPEN ANY TABLES, OR
-- DEAL ANY HANDS UNTIL I AUTHORIZE IT". While ca_diamond_arena_owner_closure.closed
-- is true, a detector reporting that a closed-arena table or tournament is not
-- dealing is describing the owner's decision, not a fault. Such a finding is kept
-- (audit) but filed resolved at info, so it opens no incident and pages nobody.
-- A finding that also names any open-arena table/tournament is left untouched.
CREATE OR REPLACE FUNCTION public.fn_ca_closed_arena_finding_is_intended()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public','pg_temp'
AS $function$
DECLARE v_closed uuid[]; v_ids uuid[]; v_in_closed int:=0; v_in_open int:=0; v_text text;
BEGIN
 IF NEW.resolved IS TRUE THEN RETURN NEW; END IF;
 SELECT COALESCE(array_agg(club_id),'{}') INTO v_closed FROM public.ca_diamond_arena_owner_closure WHERE closed;
 IF cardinality(v_closed)=0 THEN RETURN NEW; END IF;
 v_text:=COALESCE(NEW.message,'')||' '||COALESCE(NEW.context::text,'');
 IF v_text ILIKE '%Diamond Tournaments Are Not Open%' THEN
  v_in_closed:=1;
 ELSE
  SELECT array_agg(DISTINCT m[1]::uuid) INTO v_ids
    FROM regexp_matches(v_text,'([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})','g') m;
  IF v_ids IS NULL THEN RETURN NEW; END IF;
  SELECT count(*) FILTER (WHERE club_id=ANY(v_closed)), count(*) FILTER (WHERE NOT club_id=ANY(v_closed))
    INTO v_in_closed, v_in_open
    FROM (SELECT club_id FROM public.tournaments WHERE id=ANY(v_ids)
          UNION ALL SELECT club_id FROM public.tables WHERE id=ANY(v_ids)) x;
 END IF;
 IF v_in_closed>0 AND v_in_open=0 THEN
  NEW.severity:='info';
  NEW.resolved:=true;
  NEW.resolved_at:=now();
  NEW.resolution:='Diamond Arena is closed by the owner (2026-10-31); this table or tournament is intentionally not dealt until he authorizes reopening.';
 END IF;
 RETURN NEW;
EXCEPTION WHEN OTHERS THEN
 RETURN NEW; -- never block an alert write
END $function$;

DROP TRIGGER IF EXISTS a0_closed_arena_finding_is_intended ON public.financial_alerts;
CREATE TRIGGER a0_closed_arena_finding_is_intended
 BEFORE INSERT ON public.financial_alerts
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_closed_arena_finding_is_intended();