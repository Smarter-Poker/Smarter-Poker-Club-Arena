-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826054754; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

DO $preflight$
DECLARE v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad FROM public.tournaments
   WHERE COALESCE(is_multi_day,false) IS TRUE OR COALESCE(total_days,1) > 1;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'refusing to install the guard: % existing tournaments already carry a multi-day flag, so this would strand them on their next update', v_bad;
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_tournaments_refuse_unbuilt_multi_day()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF COALESCE(NEW.is_multi_day, false) IS TRUE OR COALESCE(NEW.total_days, 1) > 1 THEN
    RAISE EXCEPTION
      'Multi day tournaments are not built yet. There is no day end, no Day 2 resume and no flight merge, so this event would play down to a single winner in one session while the lobby promised otherwise. Leave multi day off.'
      USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.fn_tournaments_refuse_unbuilt_multi_day() IS
  'Refuses is_multi_day / total_days > 1 because no Day 2 resume or flight merge exists. Drop this trigger in the same migration that implements them.';

DROP TRIGGER IF EXISTS trg_tournaments_refuse_unbuilt_multi_day ON public.tournaments;

CREATE TRIGGER trg_tournaments_refuse_unbuilt_multi_day
BEFORE INSERT OR UPDATE OF is_multi_day, total_days ON public.tournaments
FOR EACH ROW
EXECUTE FUNCTION public.fn_tournaments_refuse_unbuilt_multi_day();

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname='trg_tournaments_refuse_unbuilt_multi_day'
       AND tgrelid='public.tournaments'::regclass AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'the guard trigger did not land'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname='trg_tournaments_refuse_unbuilt_multi_day'
       AND tgrelid='public.tournaments'::regclass AND tgenabled='D'
  ) THEN RAISE EXCEPTION 'the guard trigger landed disabled'; END IF;
END
$verify$;
