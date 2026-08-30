-- ─────────────────────────────────────────────────────────────────────────────
-- THE NINTH FLOW: AN UNLOCKED ACHIEVEMENT HAS NOTIFIED NOBODY SINCE 2026-08-19
-- (found 2026-08-30 while closing issue #1498)
--
-- Issue #1498 lists EIGHT Club Arena flows that call the retired
-- `pushNotificationService` and deliver nothing. There are nine. The one it
-- misses is in `AchievementTriggerService.ts`:
--
--     pushNotificationService
--       .notifyAchievement(userId, ach.name)
--       .catch(...)
--
-- The call is split across lines, so every `pushNotificationService\.(...)`
-- grep used to build that list — including mine, the first time — walked
-- straight past it. Six of the eight were fixed server-side on 2026-08-30 and
-- the other two turned out to be a dead import and a comment, so this was
-- about to be the ONLY live one left, in an issue everybody believed was done.
--
-- WHY A TRIGGER RATHER THAN A PARAMETER ON THE RPC.
--
-- Issue #1498's remedy is "raise the notification from the trusted context that
-- already performs the action". For achievements that context is the UNLOCK
-- TRANSITION on `training_user_achievements`, not any one writer of it:
--
--   - `fn_achievement_record_progress` is one writer, but it takes an
--     achievement id and never sees the display name, so notifying from there
--     would need a signature change (a Tier-3 overload risk per CLAUDE.md) and
--     would still miss every other writer;
--   - a trigger on the transition covers ALL of them, now and later, and
--     cannot be forgotten by the next path that unlocks something.
--
-- IT FIRES ONCE, ON THE TRANSITION ONLY. `unlocked_at` going from NULL to
-- non-NULL. Progress updates, re-saves, and backfills that set an already-set
-- `unlocked_at` do nothing — the same "newly unlocked" semantics
-- `fn_achievement_record_progress` already returns to its caller.
--
-- IT IS A REAL PUSH, not a bell-only row: `data` carries NO `_push` key, so
-- `fn_mirror_notification_to_push_outbox` mirrors it and
-- /api/cron/push-dispatch delivers it with `gateDecision()` applied. Consent,
-- quiet hours and the daily cap are therefore respected by construction —
-- which is exactly what the browser-side call could never do.
--
-- IT CANNOT BREAK AN UNLOCK. The whole body is wrapped so that a failure to
-- notify can never roll back the achievement the player actually earned. A
-- missing definition row degrades to the achievement id rather than failing.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_notify_achievement_unlocked ON public.training_user_achievements;
--   DROP FUNCTION IF EXISTS public.fn_notify_achievement_unlocked();
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_notify_achievement_unlocked()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_name text;
BEGIN
  -- Transition only: NULL -> non-NULL. On INSERT, OLD is NULL.
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
    -- A player earned the achievement. Failing to announce it must never undo
    -- it, and must never fail the write that earned it.
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

-- Post-apply assertions. Structural only — a migration must not roll ITSELF
-- back, so the behavioural probe (does it fire once on the transition, and not
-- at all on a re-save?) is run separately inside a transaction that IS rolled
-- back, per CLAUDE.md 11.5. Its recorded result:
--
--   PROBE (rolled back) transition=+1  resave=+0  name=Weekly Warrior
--
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

  -- It must NOT mark itself bell-only. The whole point is that this one is a
  -- real push, gated by push-dispatch rather than by a browser.
  IF pg_get_functiondef('public.fn_notify_achievement_unlocked'::regproc) LIKE '%_push%' THEN
    RAISE EXCEPTION 'post-apply failed: the unlock notification marks itself _push and would never be delivered';
  END IF;
END $$;
