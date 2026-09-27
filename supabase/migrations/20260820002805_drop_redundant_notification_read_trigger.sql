-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820002805 "drop_redundant_notification_read_trigger"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 462c38d544eacbba0578fb2a6adeebe4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Remove the redundant read-state trigger on public.notifications      Tier 2
-- ============================================================================
-- Two triggers were maintaining the same thing:
--
--   trg_sync_notification_read        BEFORE UPDATE, fn_sync_notification_read
--                                     syncs read <-> is_read only
--   trg_sync_notification_read_state  BEFORE INSERT OR UPDATE,
--                                     sync_notification_read_state
--                                     syncs read, is_read AND read_at
--
-- The second is a strict superset: it handles INSERT as well as UPDATE, and it
-- owns read_at, which the feed and the unread index depend on. The first only
-- ever mirrors the two booleans the second is about to recompute anyway.
--
-- Verified before dropping: the first trigger's mutation of NEW.is_read cannot
-- change the second's outcome, because whenever no representation is DISTINCT
-- the second falls through to the OR-of-all-three default. So this is redundant
-- work on every write, not a behavioural difference -- but two triggers writing
-- the same columns is exactly the shape that makes a future edit to one of them
-- produce a bug nobody can reproduce.
--
-- Dropping the OTHER one would break read_at. This is the safe direction.
-- ============================================================================

DROP TRIGGER IF EXISTS trg_sync_notification_read ON public.notifications;
DROP FUNCTION IF EXISTS public.fn_sync_notification_read();

-- ---------------------------------------------------------------------------
-- POST-APPLY ASSERTIONS -- the survivor must still keep all three in step.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_uid uuid; v_id uuid; v_read boolean; v_is_read boolean; v_read_at timestamptz;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.notifications'::regclass
       AND tgname = 'trg_sync_notification_read'
  ) THEN
    RAISE EXCEPTION 'redundant trigger still present';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.notifications'::regclass
       AND tgname = 'trg_sync_notification_read_state'
  ) THEN
    RAISE EXCEPTION 'the surviving read-state trigger is missing';
  END IF;

  SELECT id INTO v_uid FROM public.profiles ORDER BY created_at LIMIT 1;
  IF v_uid IS NULL THEN RETURN; END IF;

  -- INSERT unread: all three must agree.
  INSERT INTO public.notifications (user_id, type, title, message, read, is_read, data)
  VALUES (v_uid, 'system', 'trigger probe', 'x', false, false, '{"_push":"none"}'::jsonb)
  RETURNING id INTO v_id;
  SELECT read, is_read, read_at INTO v_read, v_is_read, v_read_at
    FROM public.notifications WHERE id = v_id;
  IF v_read OR v_is_read OR v_read_at IS NOT NULL THEN
    RAISE EXCEPTION 'insert did not settle unread: read=% is_read=% read_at=%', v_read, v_is_read, v_read_at;
  END IF;

  -- Mark read via `read` only -> is_read and read_at must follow.
  UPDATE public.notifications SET read = true WHERE id = v_id;
  SELECT read, is_read, read_at INTO v_read, v_is_read, v_read_at
    FROM public.notifications WHERE id = v_id;
  IF NOT v_read OR NOT v_is_read OR v_read_at IS NULL THEN
    RAISE EXCEPTION 'read=true did not propagate: read=% is_read=% read_at=%', v_read, v_is_read, v_read_at;
  END IF;

  -- Back to unread via is_read only -> read and read_at must follow.
  UPDATE public.notifications SET is_read = false WHERE id = v_id;
  SELECT read, is_read, read_at INTO v_read, v_is_read, v_read_at
    FROM public.notifications WHERE id = v_id;
  IF v_read OR v_is_read OR v_read_at IS NOT NULL THEN
    RAISE EXCEPTION 'is_read=false did not propagate: read=% is_read=% read_at=%', v_read, v_is_read, v_read_at;
  END IF;

  -- Mark read via read_at only -> both booleans must follow.
  UPDATE public.notifications SET read_at = now() WHERE id = v_id;
  SELECT read, is_read, read_at INTO v_read, v_is_read, v_read_at
    FROM public.notifications WHERE id = v_id;
  IF NOT v_read OR NOT v_is_read OR v_read_at IS NULL THEN
    RAISE EXCEPTION 'read_at did not propagate: read=% is_read=% read_at=%', v_read, v_is_read, v_read_at;
  END IF;

  DELETE FROM public.push_outbox WHERE related_entity_id = v_id;
  DELETE FROM public.notifications WHERE id = v_id;
END $$;

-- ROLLBACK
-- CREATE OR REPLACE FUNCTION public.fn_sync_notification_read() RETURNS trigger
--   LANGUAGE plpgsql SET search_path TO 'public' AS $f$
--   BEGIN
--     IF NEW.read IS DISTINCT FROM OLD.read THEN NEW.is_read = NEW.read; END IF;
--     IF NEW.is_read IS DISTINCT FROM OLD.is_read THEN NEW.read = NEW.is_read; END IF;
--     RETURN NEW;
--   END; $f$;
-- CREATE TRIGGER trg_sync_notification_read BEFORE UPDATE ON public.notifications
--   FOR EACH ROW WHEN (new.read IS DISTINCT FROM old.read OR new.is_read IS DISTINCT FROM old.is_read)
--   EXECUTE FUNCTION fn_sync_notification_read();
