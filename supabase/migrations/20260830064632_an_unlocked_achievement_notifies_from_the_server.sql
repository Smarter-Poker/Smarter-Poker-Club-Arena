-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830064632; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_notify_achievement_unlocked()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_name text;
BEGIN
  IF NEW.unlocked_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.unlocked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT d.name INTO v_name
      FROM public.training_achievement_definitions d
     WHERE d.id::text = NEW.achievement_id::text;

    INSERT INTO public.notifications (user_id, type, title, message, data)
    VALUES (
      NEW.user_id,
      'achievement',
      'Achievement Unlocked',
      COALESCE(NULLIF(btrim(v_name), ''), NEW.achievement_id::text),
      jsonb_build_object(
        'achievement_id', NEW.achievement_id,
        'achievement_name', COALESCE(NULLIF(btrim(v_name), ''), NEW.achievement_id::text)
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_notify_achievement_unlocked failed for user % achievement %: %',
      NEW.user_id, NEW.achievement_id, SQLERRM;
  END;

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_notify_achievement_unlocked ON public.training_user_achievements;
CREATE TRIGGER trg_notify_achievement_unlocked
  AFTER INSERT OR UPDATE OF unlocked_at ON public.training_user_achievements
  FOR EACH ROW EXECUTE FUNCTION public.fn_notify_achievement_unlocked();

COMMENT ON FUNCTION public.fn_notify_achievement_unlocked() IS
  'Raises the achievement-unlock notification server-side, on the NULL -> non-NULL transition of unlocked_at. Replaces the browser call to the retired pushNotificationService (issue #1498, ninth flow, missed because the call was split across lines). Carries no _push key, so the mirror trigger enqueues it and push-dispatch applies the consent gate. Never fails the write that earned the achievement. Added 2026-08-30.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_notify_achievement_unlocked'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: fn_notify_achievement_unlocked was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'training_user_achievements'
       AND t.tgname = 'trg_notify_achievement_unlocked' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'post-apply failed: trigger not attached to training_user_achievements';
  END IF;

  IF pg_get_functiondef('public.fn_notify_achievement_unlocked'::regproc) LIKE '%_push%' THEN
    RAISE EXCEPTION 'post-apply failed: the unlock notification marks itself _push';
  END IF;
END $$;
