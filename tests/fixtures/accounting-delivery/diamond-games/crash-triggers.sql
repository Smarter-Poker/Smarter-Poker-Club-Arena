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
CREATE TRIGGER trg_crash_rounds_append_only BEFORE DELETE OR UPDATE ON public.crash_rounds FOR EACH ROW EXECUTE FUNCTION fn_diamond_game_append_only();

