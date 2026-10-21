-- Individual player percentages use the same authorized path as explicit-zero
-- selection. Existing table UPDATE grants must not bypass agreement caps.
-- Version reserved by scripts/new-migration.mjs.
-- @live-proof: strpos(pg_get_functiondef('public.fn_member_rakeback_explicit_guard()'::regprocedure),'NEW.player_rakeback_pct IS DISTINCT FROM OLD.player_rakeback_pct')>0
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $$BEGIN
 IF md5(pg_get_functiondef('public.fn_member_rakeback_explicit_guard()'::regprocedure))<>'f74cf3b11bf537ea445198320ca95ba7' THEN
  RAISE EXCEPTION 'Individual Rakeback Guard Preimage Changed';
 END IF;
END $$;
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
