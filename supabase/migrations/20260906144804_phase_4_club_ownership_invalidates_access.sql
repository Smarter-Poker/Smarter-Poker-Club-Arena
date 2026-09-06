-- 20260906144804_phase_4_club_ownership_invalidates_access.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
BEGIN;

SET LOCAL lock_timeout = '30s';

-- Keep the existing union_id trigger untouched and add the previously missing
-- owner_id path. This avoids a drop/recreate gap and gives this hot table one
-- short, independently retryable lock acquisition.
DROP TRIGGER IF EXISTS trg_club_owner_emit_management_access ON public.clubs;
CREATE TRIGGER trg_club_owner_emit_management_access
AFTER UPDATE OF owner_id ON public.clubs
FOR EACH ROW EXECUTE FUNCTION public.fn_emit_club_union_access_event();

DO $assert$
DECLARE v_trigger text;
BEGIN
  SELECT pg_get_triggerdef(t.oid) INTO v_trigger
    FROM pg_trigger t
   WHERE t.tgrelid='public.clubs'::regclass
     AND t.tgname='trg_club_owner_emit_management_access'
     AND NOT t.tgisinternal;
  IF v_trigger NOT LIKE '%UPDATE OF owner_id%' THEN
    RAISE EXCEPTION 'club ownership invalidation trigger is absent: %',v_trigger;
  END IF;
END;
$assert$;

COMMIT;
