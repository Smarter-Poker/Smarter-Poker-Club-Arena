-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420015304 "phase40_allow_nested_trigger_updates_on_groups"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 85ee9ba14cf71ff0265015aa94b2fa13 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 42 follow-up: the protect trigger blocks member_count,
-- games_hosted, share_click_count updates even when they come from legitimate
-- nested triggers (e.g., update_home_group_member_count fires on a user's
-- INSERT into commander_home_members). Those triggers run INVOKER security
-- in the caller's context so auth.role() stays 'authenticated'.
--
-- Fix: use pg_trigger_depth() to detect nested-trigger calls. Depth=1 means
-- the user is directly UPDATING the groups table; depth>=2 means a trigger
-- fired downstream. Legitimate recompute triggers always have depth>=2 —
-- they're reacting to some other table's INSERT/UPDATE/DELETE.
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
BEGIN
    -- Service role bypass
    IF auth.role() = 'service_role' OR v_caller IS NULL THEN
      RETURN NEW;
    END IF;

    -- Nested-trigger bypass: when an INSERT/UPDATE/DELETE on another table
    -- fires a trigger that updates THIS table, pg_trigger_depth() > 1.
    -- Those are internal recompute paths (member_count, games_hosted,
    -- last_activity_at, etc.). Direct user UPDATE is always depth = 1.
    IF pg_trigger_depth() > 1 THEN
      RETURN NEW;
    END IF;

    v_is_owner := (NEW.owner_id = v_caller);

    -- Owner-only fields
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

    -- Computed/immutable fields blocked for direct UPDATE by anyone
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
