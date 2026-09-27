-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260426003729 "20260426020000_hg_staff_helper_includes_co_host"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e9546d7e26a142750dbf6e94e5f4360f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG FIX: systemic role-handling inconsistency.
--
-- Audit showed two camps in the codebase:
--   "admin+co_host" — 5 newer host-facing RPCs (fn_get_home_group_dashboard,
--                     list_home_group_reports_for_host, resolve_home_report_as_host, etc.)
--   "admin ONLY"   — 14 places using fn_home_is_group_staff helper or open-coded checks
--
-- A co_host CAN moderate reports (because the host RPCs include them) but
-- CANNOT update group settings, edit games, delete posts, etc. — all enforced
-- by the admin-only camp. The first time a host promotes someone to co_host,
-- they hit a confusing permission cliff between functions and policies.
--
-- Fix: update fn_home_is_group_staff to include co_host. This is the helper
-- used by 12 policies + 6 trigger fns, so one change brings 18 sites into
-- consistency with the 5 host RPCs.
--
-- The helper's name ("is_group_staff") semantically already implies anyone
-- with elevated privileges in the group — co_host is exactly that.

CREATE OR REPLACE FUNCTION public.fn_home_is_group_staff(
  p_caller uuid, p_group_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
STABLE
AS $$
BEGIN
    IF p_caller IS NULL OR p_group_id IS NULL THEN RETURN false; END IF;

    -- Group owner → always staff
    IF EXISTS (SELECT 1 FROM commander_home_groups
               WHERE id = p_group_id AND owner_id = p_caller) THEN
        RETURN true;
    END IF;

    -- Approved member with elevated role
    IF EXISTS (SELECT 1 FROM commander_home_members
               WHERE group_id = p_group_id
                 AND user_id = p_caller
                 AND status = 'approved'
                 AND role IN ('owner','admin','co_host')) THEN  -- ← was ('owner','admin')
        RETURN true;
    END IF;

    RETURN false;
END;
$$;
