CREATE OR REPLACE FUNCTION public.fn_diamond_bonus_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF TG_OP='UPDATE' AND OLD.result IS NULL AND NEW.result IS NOT NULL
  AND to_jsonb(OLD)-ARRAY['result','total_diamonds']=to_jsonb(NEW)-ARRAY['result','total_diamonds'] THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'A Saved Bonus Cannot Be Rewritten';
END $function$
;
DROP TRIGGER IF EXISTS diamond_bonus_immutable ON public.diamond_bonus_entries;
CREATE TRIGGER diamond_bonus_immutable BEFORE DELETE OR UPDATE ON public.diamond_bonus_entries FOR EACH ROW EXECUTE FUNCTION fn_diamond_bonus_immutable();
CREATE OR REPLACE FUNCTION public.fn_diamond_spins_consent_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN RAISE EXCEPTION 'An Owner Agreement Is A Permanent Receipt' USING ERRCODE='integrity_constraint_violation'; END $function$
;
DROP TRIGGER IF EXISTS diamond_spins_consent_immutable ON public.diamond_spins_owner_consents;
CREATE TRIGGER diamond_spins_consent_immutable BEFORE DELETE OR UPDATE ON public.diamond_spins_owner_consents FOR EACH ROW EXECUTE FUNCTION fn_diamond_spins_consent_immutable();
CREATE OR REPLACE FUNCTION public.fn_diamond_game_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NULLIF(current_setting('app.ledger_maintenance', true), '') IS NOT NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_TABLE_NAME = 'crash_rounds' AND TG_OP = 'UPDATE' AND OLD.status = 'open' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only: a settled round is a fact and is never edited or deleted', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END $function$
;
DROP TRIGGER IF EXISTS trg_plinko_drops_append_only ON public.plinko_drops;
CREATE TRIGGER trg_plinko_drops_append_only BEFORE DELETE OR UPDATE ON public.plinko_drops FOR EACH ROW EXECUTE FUNCTION fn_diamond_game_append_only();
