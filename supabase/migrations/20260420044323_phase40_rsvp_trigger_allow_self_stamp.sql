-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420044323 "phase40_rsvp_trigger_allow_self_stamp"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c501f0839242b522b1574aeabed8a578 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 47 regression fix: claim_home_game_seat stamps checked_in_at
-- on the RSVPing user's own RSVP row as part of the seat-claim flow. The
-- field-permission trigger from bug #47 blocks this because the stamp is
-- coming from the user (not host).
--
-- Compromise: allow RSVP-owner to set checked_in_at from NULL → timestamp
-- (first stamp only). Prevents the retroactive-fraud direct-UPDATE scenario
-- (row already has checked_in_at=NULL but attacker wants to backfill it)
-- while preserving seat-claim semantics.
--
-- Additional guardrail: checked_in_by must match caller when self-stamping,
-- or be NULL (default for claim_seat which doesn't set it).
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
    v_checkin_self_stamp boolean := false;
BEGIN
    IF auth.role() = 'service_role' OR v_caller IS NULL THEN RETURN NEW; END IF;
    IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

    v_is_self := (NEW.user_id = v_caller);

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

    -- Detect a legit "RSVP-owner first-stamp": row's checked_in_at was NULL,
    -- now being set by the RSVP owner themselves (as in claim_home_game_seat).
    -- Also allow clearing flaked=false during same transition.
    v_checkin_self_stamp := (
      v_is_self
      AND OLD.checked_in_at IS NULL
      AND NEW.checked_in_at IS NOT NULL
    );

    -- Attendance fields: host/owner/admin only, except for the specific
    -- self-stamp-from-NULL case above.
    IF NEW.checked_in_at IS DISTINCT FROM OLD.checked_in_at
       OR NEW.checked_in_by IS DISTINCT FROM OLD.checked_in_by
       OR NEW.flaked        IS DISTINCT FROM OLD.flaked
       OR NEW.final_result_note IS DISTINCT FROM OLD.final_result_note
       OR NEW.seat_number   IS DISTINCT FROM OLD.seat_number
       OR NEW.is_confirmed  IS DISTINCT FROM OLD.is_confirmed
    THEN
      IF NOT v_is_host AND NOT v_checkin_self_stamp THEN
        RAISE EXCEPTION 'HOST_ONLY_FIELD'
              USING HINT = 'checked_in_at, checked_in_by, flaked, '
                         || 'final_result_note, seat_number, is_confirmed '
                         || 'can only be set by game host / group owner / admin';
      END IF;
    END IF;

    -- System-only fields
    IF NEW.reminder_6h_sent_at IS DISTINCT FROM OLD.reminder_6h_sent_at
       OR NEW.reminder_1h_sent_at IS DISTINCT FROM OLD.reminder_1h_sent_at
       OR NEW.review_prompt_sent_at IS DISTINCT FROM OLD.review_prompt_sent_at
       OR NEW.responded_at IS DISTINCT FROM OLD.responded_at
    THEN
      RAISE EXCEPTION 'SYSTEM_ONLY_FIELD'
            USING HINT = 'reminder/review timestamps and responded_at are '
                       || 'managed by the system';
    END IF;

    -- Non-self cannot change response fields
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

COMMENT ON FUNCTION public.fn_enforce_home_rsvp_field_permissions IS
  'Phase 40 Bug 47 + regression fix: host-only attendance fields, with a '
  'narrow exception for RSVP-owner first-stamping checked_in_at from NULL '
  '(preserves claim_home_game_seat semantics). Once stamped, only host/'
  'owner/admin can modify.';
