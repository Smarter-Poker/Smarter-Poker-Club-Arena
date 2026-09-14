-- Derivative away state belongs to a player, not the reusable seat row.
-- No data backfill, money write, or admission/authorization change.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF md5(pg_get_functiondef('public.fn_clear_sitout_on_turnover()'::regprocedure)) <> '6adbb2ed891454b185a9092d0a43196c'
 OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass
  AND tgname='trg_clear_sitout_on_turnover' AND tgenabled='O' AND tgtype=19
  AND tgfoid='public.fn_clear_sitout_on_turnover()'::regprocedure
  AND tgqual IS NULL AND tgnargs=0 AND tgattr=''::int2vector) THEN
  RAISE EXCEPTION 'Seat turnover predecessor changed; review before installation';
 END IF;
END;
$preflight$;
CREATE OR REPLACE FUNCTION public.fn_clear_sitout_on_turnover()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  -- A different occupant never inherits the prior player's away state.
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR (NEW.left_at IS NOT NULL AND OLD.left_at IS NULL) THEN
    NEW.is_sitting_out := false;
    NEW.sit_out_at := NULL;
  ELSIF NEW.left_at IS NULL AND OLD.left_at IS NOT NULL
        AND NEW.is_sitting_out IS NOT DISTINCT FROM OLD.is_sitting_out THEN
    NEW.is_sitting_out := false;
    NEW.sit_out_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
VALUES('table_seats','trg_clear_sitout_on_turnover','Clear inherited sit-out flag and clock when the seat occupant changes; preserve same-player timers and ordinary financial fields.')
ON CONFLICT(table_name,trigger_name) DO UPDATE SET note=EXCLUDED.note;
COMMIT;
