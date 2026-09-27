-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420004006 "phase40_fix_members_rls_recursion_and_field_escalation"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 bcd9da5a3a8eb90b6b9d4ce5f9e68a84 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40: Two compound bugs in commander_home_members RLS
--
-- BUG A (recursion): home_members_update and home_members_insert policies
-- contain self-referencing subqueries (SELECT FROM commander_home_members)
-- which causes "infinite recursion detected in policy" when any UPDATE or
-- INSERT is evaluated in certain contexts. Critical — the table becomes
-- unusable from the app for operations that hit the recursive disjunct.
--
-- BUG B (privilege escalation): neither policy has a WITH CHECK restricting
-- which COLUMNS the acting user can change. Combined with the permissive
-- "user_id = auth.uid()" disjunct in USING, this means:
--   - a pending member can self-approve (status: pending → approved)
--   - any member can self-promote (role: member → admin)
--   - any member can clear their own flake_strikes
--   - any member can set is_regular=true on themselves (host designation)
--   - any member can set can_host=true on themselves
--   - any member can rewrite host_private_note (staff-only field)
--
-- FIX A: rewrite policies to use fn_home_is_group_staff SECURITY DEFINER
-- helpers, which internally use SET row_security = off to guarantee
-- no re-entry into the same policy stack.
--
-- FIX B: add a BEFORE UPDATE trigger that blocks non-staff from touching
-- privileged fields on any row (including their own).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A1: harden helper functions to explicitly bypass RLS. Cleaner than
-- depending on the owner role having BYPASSRLS.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_home_is_approved_member(p_caller uuid, p_group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO off
AS $function$
    SELECT CASE
        WHEN p_caller IS NULL OR p_group_id IS NULL THEN false
        ELSE EXISTS (
            SELECT 1 FROM commander_home_members
             WHERE group_id = p_group_id
               AND user_id  = p_caller
               AND status   = 'approved'
        )
    END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_home_is_group_staff(p_caller uuid, p_group_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO off
AS $function$
BEGIN
    IF p_caller IS NULL OR p_group_id IS NULL THEN RETURN false; END IF;

    IF EXISTS (SELECT 1 FROM commander_home_groups
               WHERE id = p_group_id AND owner_id = p_caller) THEN
        RETURN true;
    END IF;

    IF EXISTS (SELECT 1 FROM commander_home_members
               WHERE group_id = p_group_id
                 AND user_id = p_caller
                 AND status = 'approved'
                 AND role IN ('owner','admin')) THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$function$;

-- ----------------------------------------------------------------------------
-- A2: rewrite the three problematic policies. Drop the self-referencing
-- subquery entirely and use fn_home_is_group_staff instead. This eliminates
-- the recursion path.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS home_members_update ON commander_home_members;
CREATE POLICY home_members_update ON commander_home_members
FOR UPDATE
USING (
  user_id = auth.uid()
  OR fn_home_is_group_staff(auth.uid(), group_id)
)
WITH CHECK (
  user_id = auth.uid()
  OR fn_home_is_group_staff(auth.uid(), group_id)
);

DROP POLICY IF EXISTS home_members_insert ON commander_home_members;
CREATE POLICY home_members_insert ON commander_home_members
FOR INSERT
WITH CHECK (
  user_id = auth.uid()
  OR fn_home_is_group_staff(auth.uid(), group_id)
);

DROP POLICY IF EXISTS home_members_delete ON commander_home_members;
CREATE POLICY home_members_delete ON commander_home_members
FOR DELETE
USING (
  user_id = auth.uid()
  OR fn_home_is_group_staff(auth.uid(), group_id)
);

-- ----------------------------------------------------------------------------
-- B: BEFORE UPDATE trigger that blocks non-staff from mutating privileged
-- fields on any row. A user can still update their own notification
-- preferences / notes / timestamps, but NOT role, status, can_host,
-- is_regular, flake_strikes, host_private_note, probation_until, or
-- invited_by.
--
-- If the caller IS staff (via fn_home_is_group_staff), all changes pass.
-- If the caller is the row's user (user_id = auth.uid()) but NOT staff,
-- only non-privileged fields may change.
--
-- The existing owner-protect trigger (trg_protect_home_group_owner_membership_upd)
-- also fires BEFORE UPDATE, but only guards the single owner row's role/status.
-- This new trigger guards all members more broadly.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_enforce_home_member_field_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET row_security TO off
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_is_staff boolean;
  v_is_self  boolean;
BEGIN
  -- Internal / cron / trigger-chain operations (no JWT) pass through.
  -- API calls always have auth.uid() set.
  IF v_caller IS NULL THEN
    RETURN NEW;
  END IF;

  v_is_staff := fn_home_is_group_staff(v_caller, NEW.group_id);
  v_is_self  := (v_caller = NEW.user_id);

  -- Staff can change anything (bounded by the owner-protect trigger for the
  -- single owner row).
  IF v_is_staff THEN
    RETURN NEW;
  END IF;

  -- Non-staff cannot touch another person's row at all. The RLS policy should
  -- already block this, but defense-in-depth.
  IF NOT v_is_self THEN
    RAISE EXCEPTION 'Cannot modify another member''s row'
      USING ERRCODE = '42501';
  END IF;

  -- Self-update on non-staff: block changes to privileged fields
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

  -- Allowed self-updates: notifications_enabled, notify_*, last_read_posts_at,
  -- pending_nudge_sent_at (used by crons but no harm if user clears),
  -- games_attended/hosted (derived, but not privileged), last_attended,
  -- joined_at (can't backdate a self-join meaningfully).
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_home_member_field_permissions ON commander_home_members;
CREATE TRIGGER trg_enforce_home_member_field_permissions
  BEFORE UPDATE ON commander_home_members
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_home_member_field_permissions();

COMMENT ON TRIGGER trg_enforce_home_member_field_permissions ON commander_home_members IS
  'Phase 40: blocks non-staff members from mutating privileged fields on '
  'their own row (role, status, can_host, is_regular, flake_strikes, '
  'host_private_note, probation_until, invited_by, group_id, user_id). '
  'Staff can change anything (bounded by owner-protect trigger).';
