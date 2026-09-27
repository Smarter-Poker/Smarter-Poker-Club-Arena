-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419224823 "phase37_fix_rls_recursion_home_members"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 35281c0ee74b808354becfff1e4543d1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Pre-existing bug: RLS policy home_members_host_sees_group self-references
-- commander_home_members in a subquery, causing infinite recursion on any
-- direct SELECT by authenticated. Production is unaffected because the
-- frontend uses SECURITY DEFINER fns (which bypass RLS), but the bug traps
-- anyone writing a direct .from('commander_home_members') query.
--
-- Fix: replace self-referencing subqueries with SECURITY DEFINER helpers.
-- Helpers run with the function owner's privileges so they bypass RLS and
-- don't re-trigger the policy they're helping evaluate.
-- ============================================================================

-- New helper: is the caller an approved member of this group? (not just staff)
CREATE OR REPLACE FUNCTION public.fn_home_is_approved_member(
    p_caller uuid, p_group_id uuid
) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
    SELECT CASE
        WHEN p_caller IS NULL OR p_group_id IS NULL THEN false
        ELSE EXISTS (
            SELECT 1 FROM commander_home_members
             WHERE group_id = p_group_id
               AND user_id  = p_caller
               AND status   = 'approved'
        )
    END;
$fn$;

COMMENT ON FUNCTION public.fn_home_is_approved_member(uuid, uuid) IS
    'Phase 37: RLS helper. SECURITY DEFINER so it bypasses the policy on '
    'commander_home_members, preventing infinite recursion in policies that '
    'need to check membership while reading the same table.';

GRANT EXECUTE ON FUNCTION public.fn_home_is_approved_member(uuid, uuid)
    TO authenticated, service_role;

-- Replace the recursive policy
DROP POLICY IF EXISTS home_members_host_sees_group ON public.commander_home_members;

CREATE POLICY home_members_host_sees_group
    ON public.commander_home_members
    FOR SELECT
    TO authenticated
    USING (
        -- Hosts (owner or approved admin) see every row in their group
        public.fn_home_is_group_staff(auth.uid(), group_id)
        -- Approved members see each other's approved rows
        OR (status = 'approved'
            AND public.fn_home_is_approved_member(auth.uid(), group_id))
    );

COMMENT ON POLICY home_members_host_sees_group ON public.commander_home_members IS
    'Phase 37: rewritten to use SECURITY DEFINER helpers so the policy does '
    'not self-reference the table and trigger infinite recursion.';
