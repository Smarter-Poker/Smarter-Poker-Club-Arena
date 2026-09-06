-- A union_clubs row may be reassigned by a privileged maintenance workflow.
-- The Phase 4 trigger originally watched only INSERT and DELETE, leaving both
-- the old and new operator consoles visually stale after UPDATE. This is its
-- own transaction because combining AccessExclusive locks on multiple hot
-- relationship tables deadlocked against Supabase Realtime in production.

BEGIN;

SET LOCAL lock_timeout = '30s';

-- Keep the live INSERT/DELETE trigger in place. DROP TRIGGER invokes
-- Supabase's sql_drop event trigger and deadlocks with the realtime worker on
-- this table; a separate UPDATE trigger adds the missing edge without that
-- lock inversion.
CREATE TRIGGER trg_union_clubs_reassignment_management_access
AFTER UPDATE OF union_id, club_id ON public.union_clubs
FOR EACH ROW EXECUTE FUNCTION public.fn_emit_management_access_event();

DO $assert$
DECLARE v_trigger text;
BEGIN
  SELECT pg_get_triggerdef(t.oid) INTO v_trigger
    FROM pg_trigger t
   WHERE t.tgrelid='public.union_clubs'::regclass
     AND t.tgname='trg_union_clubs_reassignment_management_access'
     AND NOT t.tgisinternal;
  IF v_trigger NOT LIKE '%UPDATE OF union_id, club_id%' THEN
    RAISE EXCEPTION 'union_clubs access invalidation does not cover reassignment: %',v_trigger;
  END IF;
END;
$assert$;

COMMIT;
