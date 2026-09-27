-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420220815 "phase41_bughunt_member_joined_at_immutable"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 74da9a396fb6ea86e44199f3f5671c72 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =====================================================================
-- Phase 41 bug-hunt pass 36b: block self-backdating of joined_at.
--
-- BUG (verified):
--   BU — a member can UPDATE their own joined_at column to an arbitrary
--        past date (e.g., 2020-01-01), faking tenure / seniority. This
--        affects any features that rank members by tenure, founding
--        member badges, seniority-based rewards, etc.
--
--   The original fn_enforce_home_member_field_permissions comment read
--   "can't backdate a self-join meaningfully" — but in fact the
--   database accepts the backdate, and the business consequence is
--   visible tenure falsification.
--
-- FIX:
--   Add joined_at to the protected fields in
--   fn_enforce_home_member_field_permissions:
--     - Self-updates cannot change joined_at (any direction).
--     - Staff can still change (e.g., to correct data errors).
--     - Service role bypasses via the early NULL-auth branch.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.fn_enforce_home_member_field_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET row_security TO 'off'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_is_staff boolean;
  v_is_self  boolean;
BEGIN
  IF v_caller IS NULL THEN
    RETURN NEW;
  END IF;

  v_is_staff := fn_home_is_group_staff(v_caller, NEW.group_id);
  v_is_self  := (v_caller = NEW.user_id);

  IF v_is_staff THEN
    RETURN NEW;
  END IF;

  IF NOT v_is_self THEN
    RAISE EXCEPTION 'Cannot modify another member''s row'
      USING ERRCODE = '42501';
  END IF;

  -- privileged field guards
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'Cannot change your own role. Only group staff can change member roles.'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Cannot change your own status. Only group staff can approve/ban members.'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.can_host IS DISTINCT FROM OLD.can_host THEN
    RAISE EXCEPTION 'Cannot change your own can_host flag. Only group staff can grant hosting.'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.is_regular IS DISTINCT FROM OLD.is_regular THEN
    RAISE EXCEPTION 'Cannot change your own is_regular flag. Only group staff can mark regulars.'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.flake_strikes IS DISTINCT FROM OLD.flake_strikes THEN
    RAISE EXCEPTION 'Cannot change your own flake_strikes. Only group staff can adjust strikes.'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.host_private_note IS DISTINCT FROM OLD.host_private_note THEN
    RAISE EXCEPTION 'Cannot edit host_private_note. This is a staff-only field.'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.probation_until IS DISTINCT FROM OLD.probation_until THEN
    RAISE EXCEPTION 'Cannot change your own probation_until. Only group staff can set probation.'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.invited_by IS DISTINCT FROM OLD.invited_by THEN
    RAISE EXCEPTION 'Cannot change invited_by. This reflects historical join path.'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.group_id IS DISTINCT FROM OLD.group_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Cannot reassign group_id or user_id on a member row.'
      USING ERRCODE = '42501';
  END IF;

  -- Pass 36b: joined_at is historical — faking tenure is a seniority / ranking
  -- bug. Staff can still adjust for data-correction cases (via the v_is_staff
  -- bypass above).
  IF NEW.joined_at IS DISTINCT FROM OLD.joined_at THEN
    RAISE EXCEPTION 'Cannot change your own joined_at. This reflects historical join date.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;
