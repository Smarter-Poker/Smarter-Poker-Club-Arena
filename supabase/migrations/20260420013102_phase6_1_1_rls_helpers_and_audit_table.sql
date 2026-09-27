-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420013102 "phase6_1_1_rls_helpers_and_audit_table"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5a18f277ab519cfe080abb167bad914a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 6.1.1 — RLS helpers + audit table baseline
-- Step 1 of 4: helpers + RLS on _audit_phase40_results
-- ============================================================================

-- ── Helper: fn_is_platform_admin() — caller-aware platform-admin check ──────
CREATE OR REPLACE FUNCTION public.fn_is_platform_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_role text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  RETURN v_role IN ('admin', 'superadmin', 'god');
END;
$$;
REVOKE ALL ON FUNCTION public.fn_is_platform_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_is_platform_admin() TO authenticated;

-- ── Helper: fn_is_club_member_uid(p_club_id) — current-user club membership ─
CREATE OR REPLACE FUNCTION public.fn_is_club_member_uid(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.club_members
    WHERE club_id = p_club_id
      AND user_id = auth.uid()
      AND COALESCE(status, 'active') = 'active'
  );
$$;
REVOKE ALL ON FUNCTION public.fn_is_club_member_uid(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_is_club_member_uid(uuid) TO authenticated;

-- ── Helper: fn_is_club_admin_uid(p_club_id) — current-user club-admin check ─
CREATE OR REPLACE FUNCTION public.fn_is_club_admin_uid(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.club_members cm
    WHERE cm.club_id = p_club_id
      AND cm.user_id = auth.uid()
      AND cm.role IN ('owner','admin','manager')
      AND COALESCE(cm.status, 'active') = 'active'
  );
$$;
REVOKE ALL ON FUNCTION public.fn_is_club_admin_uid(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_is_club_admin_uid(uuid) TO authenticated;

-- ── Enable RLS on the lone unguarded table (_audit_phase40_results) ─────────
ALTER TABLE public._audit_phase40_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_phase40_admin_read ON public._audit_phase40_results;
CREATE POLICY audit_phase40_admin_read
  ON public._audit_phase40_results
  FOR SELECT
  TO authenticated
  USING (public.fn_is_platform_admin());

COMMENT ON FUNCTION public.fn_is_platform_admin() IS
  'Phase 6.1.1 — RLS helper. Returns true iff auth.uid() is a platform admin.';
COMMENT ON FUNCTION public.fn_is_club_member_uid(uuid) IS
  'Phase 6.1.1 — RLS helper. Active club_members membership check for auth.uid().';
COMMENT ON FUNCTION public.fn_is_club_admin_uid(uuid) IS
  'Phase 6.1.1 — RLS helper. Owner/admin/manager role check for auth.uid().';
