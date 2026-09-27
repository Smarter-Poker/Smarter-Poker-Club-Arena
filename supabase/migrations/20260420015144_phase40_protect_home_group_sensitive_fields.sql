-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420015144 "phase40_protect_home_group_sensitive_fields"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1b57f131ab237fb9850c23bfb86656ce of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 42: home_groups UPDATE policy has no WITH CHECK, letting
-- admins (not just owners) modify arbitrary columns via direct PostgREST.
-- They can bypass edit_home_group's allowlist and:
--   - rotate invite_code / club_code (lock out owner / legitimate members)
--   - flip is_active = false (deactivate the group)
--   - inflate member_count / games_hosted / share_click_count
--   - modify created_at / updated_at
--
-- owner_id is already protected by the Phase 40 creator-invariant trigger.
--
-- Fix approach: trigger-based field permissions matching the pattern used on
-- commander_home_members. Mutations blocked by who-is-caller + what-field.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_enforce_home_group_field_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $fn$
DECLARE
    v_caller uuid := auth.uid();
    v_is_owner boolean;
    v_is_admin boolean;
BEGIN
    -- Service role and superuser contexts bypass
    IF auth.role() = 'service_role' OR v_caller IS NULL THEN
      RETURN NEW;
    END IF;

    -- Determine caller standing vs this group (post-state owner_id is what
    -- matters for "still the owner"; the owner-id-protect trigger already
    -- prevents owner_id changes, so OLD.owner_id = NEW.owner_id).
    v_is_owner := (NEW.owner_id = v_caller);
    v_is_admin := EXISTS (
      SELECT 1 FROM commander_home_members
       WHERE group_id = NEW.id AND user_id = v_caller
         AND role = 'admin' AND status = 'approved'
    );

    -- Fields only the OWNER (not admins) can change
    IF NEW.invite_code IS DISTINCT FROM OLD.invite_code
       OR NEW.club_code IS DISTINCT FROM OLD.club_code
       OR NEW.is_active IS DISTINCT FROM OLD.is_active
    THEN
      IF NOT v_is_owner THEN
        RAISE EXCEPTION 'OWNER_ONLY_FIELD'
              USING HINT = 'only the group owner can change invite_code, '
                         || 'club_code, or is_active';
      END IF;
    END IF;

    -- Fields nobody should change via direct UPDATE (computed / immutable).
    -- Triggers and SECURITY DEFINER helpers can still modify them because
    -- this trigger is bypassed when auth.role() is service_role. For owner
    -- contexts, we still block these to prevent metric inflation.
    IF NEW.member_count       IS DISTINCT FROM OLD.member_count
       OR NEW.games_hosted    IS DISTINCT FROM OLD.games_hosted
       OR NEW.share_click_count IS DISTINCT FROM OLD.share_click_count
       OR NEW.created_at      IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'IMMUTABLE_OR_COMPUTED_FIELD'
            USING HINT = 'member_count, games_hosted, share_click_count, '
                       || 'created_at are maintained by the system';
    END IF;

    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_enforce_home_group_field_permissions
  ON public.commander_home_groups;
CREATE TRIGGER trg_enforce_home_group_field_permissions
BEFORE UPDATE ON public.commander_home_groups
FOR EACH ROW
EXECUTE FUNCTION public.fn_enforce_home_group_field_permissions();

COMMENT ON FUNCTION public.fn_enforce_home_group_field_permissions IS
  'Phase 40: trigger enforces field-level permissions on commander_home_groups '
  'updates because the RLS policy has no WITH CHECK. Blocks admins from '
  'rotating invite/club codes or deactivating groups, and blocks everyone '
  'from directly mutating computed columns. Service-role bypass for legitimate '
  'SECURITY DEFINER and cron paths.';
