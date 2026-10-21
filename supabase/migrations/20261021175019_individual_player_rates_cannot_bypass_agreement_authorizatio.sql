-- Individual player percentages use the same authorized path as explicit-zero
-- selection. Existing table UPDATE grants must not bypass agreement caps.
-- Version reserved by scripts/new-migration.mjs.
-- @live-proof: strpos(pg_get_functiondef('public.fn_member_rakeback_explicit_guard()'::regprocedure),'NEW.player_rakeback_pct IS DISTINCT FROM OLD.player_rakeback_pct')>0
-- @live-proof: strpos(pg_get_functiondef('public.fn_member_rakeback_terms(uuid,uuid,text,numeric,numeric)'::regprocedure),'owner_id=member.agent_id) THEN 0.70')>0
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $$BEGIN
 IF md5(pg_get_functiondef('public.fn_member_rakeback_explicit_guard()'::regprocedure))<>'f74cf3b11bf537ea445198320ca95ba7' THEN
  RAISE EXCEPTION 'Individual Rakeback Guard Preimage Changed';
 END IF;
END $$;
-- Preserve the already-supported club-funded seventy-percent direct-owner
-- agreement; ordinary player rates still obey the existing ten-point gap.
DO $owner_deal$
DECLARE definition text; old_max text := 'maximum:=CASE WHEN FOUND THEN greatest(parent.commission_rate-0.10,0) ELSE 0.70 END;';
 old_check text := 'IF p_rate>maximum THEN RETURN';
BEGIN
 definition:=pg_get_functiondef('public.fn_member_rakeback_terms(uuid,uuid,text,numeric,numeric)'::regprocedure);
 IF md5(definition)<>'47d2a462eea57c7fde9de6cec936798e'
  OR (length(definition)-length(replace(definition,old_max,'')))/length(old_max)<>1
  OR (length(definition)-length(replace(definition,old_check,'')))/length(old_check)<>1 THEN
  RAISE EXCEPTION 'Individual Rakeback Terms Preimage Changed';
 END IF;
 definition:=replace(definition,old_max,
  'maximum:=CASE WHEN EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id AND owner_id=member.agent_id) THEN 0.70 WHEN FOUND THEN greatest(parent.commission_rate-0.10,0) ELSE 0.70 END;');
 definition:=replace(definition,old_check,
  'IF p_rate>maximum OR (p_role=''player'' AND parent.id IS NOT NULL AND p_rate>greatest(parent.commission_rate-0.10,0) AND NOT(p_rate=0.70 AND EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id AND owner_id=member.agent_id))) THEN RETURN');
 EXECUTE definition;
END $owner_deal$;
CREATE OR REPLACE FUNCTION public.fn_member_rakeback_explicit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE changed boolean;
BEGIN
 IF TG_OP='INSERT' THEN
  changed:=coalesce(NEW.player_rakeback_pct,0)<>0 OR NEW.player_rakeback_explicit;
 ELSE
  changed:=NEW.player_rakeback_pct IS DISTINCT FROM OLD.player_rakeback_pct
    OR NEW.player_rakeback_explicit IS DISTINCT FROM OLD.player_rakeback_explicit;
 END IF;
 IF changed AND current_user NOT IN ('postgres','supabase_admin','service_role') THEN
  RAISE EXCEPTION 'Individual Rakeback Must Be Set Through Its Agreement RPC' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER member_rakeback_explicit_guard ON public.club_members;
CREATE TRIGGER member_rakeback_explicit_guard BEFORE INSERT OR UPDATE OF player_rakeback_pct,player_rakeback_explicit
 ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_member_rakeback_explicit_guard();
UPDATE public.ca_declared_money_triggers
 SET note='Individual rakeback percentages and explicit zero are written only by authorized agreement RPCs.'
 WHERE table_name='club_members' AND trigger_name='member_rakeback_explicit_guard';
COMMIT;
