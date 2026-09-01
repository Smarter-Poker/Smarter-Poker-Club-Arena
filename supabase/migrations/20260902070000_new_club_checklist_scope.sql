-- New Club Checklist Scope
--
-- Legacy clubs and unions are already operating businesses; they must never
-- inherit a first-run setup gate. The nullable marker is intentionally NOT
-- backfilled. Only a club inserted after this migration receives it.

ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS opening_checklist_started_at timestamptz;

CREATE OR REPLACE FUNCTION public.fn_mark_new_club_opening_checklist()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF COALESCE(NEW.is_union, false) = false
     AND NEW.opening_checklist_started_at IS NULL THEN
    NEW.opening_checklist_started_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_mark_new_club_opening_checklist ON public.clubs;
CREATE TRIGGER trg_mark_new_club_opening_checklist
  BEFORE INSERT ON public.clubs
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_mark_new_club_opening_checklist();

COMMENT ON COLUMN public.clubs.opening_checklist_started_at IS
  'Non-null only for standalone clubs created after the new-club checklist launched. Legacy clubs and unions remain null.';

REVOKE ALL ON FUNCTION public.fn_mark_new_club_opening_checklist() FROM PUBLIC, anon, authenticated;

