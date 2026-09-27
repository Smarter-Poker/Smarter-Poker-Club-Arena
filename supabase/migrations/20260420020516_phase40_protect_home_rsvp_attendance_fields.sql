-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420020516 "phase40_protect_home_rsvp_attendance_fields"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a1a3ab3c249e216c2042d08715912af2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 47: commander_home_rsvps UPDATE policy has no WITH CHECK
-- and no field-permission trigger. A user can self-set checked_in_at,
-- flaked=false, and checked_in_by — then satisfy the review-INSERT policy's
-- "attended" gate and leave fraudulent reviews (verified end-to-end).
--
-- Fix: field-permission trigger. Users can only modify their own
-- response/guest/message fields. Host/owner/admin can additionally touch
-- attendance fields. Reminder timestamps are system-only.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_enforce_home_rsvp_field_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $fn$
DECLARE
    v_caller uuid := auth.uid();
    v_is_self boolean;
    v_is_host boolean;
BEGIN
    -- Service role + nested-trigger bypass
    IF auth.role() = 'service_role' OR v_caller IS NULL THEN RETURN NEW; END IF;
    IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

    v_is_self := (NEW.user_id = v_caller);

    -- Is caller host/owner/admin of this game's group?
    SELECT
      EXISTS (SELECT 1 FROM commander_home_games g
               WHERE g.id = NEW.game_id AND g.host_id = v_caller)
      OR EXISTS (SELECT 1 FROM commander_home_games g
                 JOIN commander_home_groups gr ON gr.id = g.group_id
                 WHERE g.id = NEW.game_id AND gr.owner_id = v_caller)
      OR EXISTS (SELECT 1 FROM commander_home_games g
                 JOIN commander_home_members m ON m.group_id = g.group_id
                 WHERE g.id = NEW.game_id
                   AND m.user_id = v_caller
                   AND m.role = 'admin'
                   AND m.status = 'approved')
    INTO v_is_host;

    -- Attendance fields: host/owner/admin only
    IF NEW.checked_in_at IS DISTINCT FROM OLD.checked_in_at
       OR NEW.checked_in_by IS DISTINCT FROM OLD.checked_in_by
       OR NEW.flaked        IS DISTINCT FROM OLD.flaked
       OR NEW.final_result_note IS DISTINCT FROM OLD.final_result_note
       OR NEW.seat_number   IS DISTINCT FROM OLD.seat_number
       OR NEW.is_confirmed  IS DISTINCT FROM OLD.is_confirmed
    THEN
      IF NOT v_is_host THEN
        RAISE EXCEPTION 'HOST_ONLY_FIELD'
              USING HINT = 'checked_in_at, checked_in_by, flaked, '
                         || 'final_result_note, seat_number, is_confirmed '
                         || 'can only be set by game host / group owner / admin';
      END IF;
    END IF;

    -- System-only: cron-managed reminder timestamps
    IF NEW.reminder_6h_sent_at IS DISTINCT FROM OLD.reminder_6h_sent_at
       OR NEW.reminder_1h_sent_at IS DISTINCT FROM OLD.reminder_1h_sent_at
       OR NEW.review_prompt_sent_at IS DISTINCT FROM OLD.review_prompt_sent_at
       OR NEW.responded_at IS DISTINCT FROM OLD.responded_at
    THEN
      RAISE EXCEPTION 'SYSTEM_ONLY_FIELD'
            USING HINT = 'reminder/review timestamps and responded_at are '
                       || 'managed by the system';
    END IF;

    -- Non-self cannot change response/bringing_guests/message/guest_names/rsvp_reason
    -- (host doesn't set someone else's RSVP response — use checked_in_at to mark
    -- attendance, not to flip yes→no).
    IF NOT v_is_self THEN
      IF NEW.response IS DISTINCT FROM OLD.response
         OR NEW.bringing_guests IS DISTINCT FROM OLD.bringing_guests
         OR NEW.message IS DISTINCT FROM OLD.message
         OR NEW.guest_names IS DISTINCT FROM OLD.guest_names
         OR NEW.rsvp_reason IS DISTINCT FROM OLD.rsvp_reason
      THEN
        RAISE EXCEPTION 'RSVP_OWNER_ONLY_FIELD'
              USING HINT = 'only the RSVPing user can change their response, '
                         || 'guest info, or message';
      END IF;
    END IF;

    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_enforce_home_rsvp_field_permissions
  ON public.commander_home_rsvps;
CREATE TRIGGER trg_enforce_home_rsvp_field_permissions
BEFORE UPDATE ON public.commander_home_rsvps
FOR EACH ROW
EXECUTE FUNCTION public.fn_enforce_home_rsvp_field_permissions();

COMMENT ON FUNCTION public.fn_enforce_home_rsvp_field_permissions IS
  'Phase 40 Bug 47: field-permission trigger. Users can change their own '
  'response/guest/message fields. Only host/owner/admin can set attendance '
  '(checked_in_at, flaked, is_confirmed, seat_number). System-only fields '
  '(reminders, responded_at) always blocked for direct UPDATE.';
