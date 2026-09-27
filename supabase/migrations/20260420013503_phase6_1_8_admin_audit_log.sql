-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420013503 "phase6_1_8_admin_audit_log"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 081e58c0852a1715a3cb10ae6597474e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 6.1.8 — Admin audit log
-- Extends existing public.admin_audit_log with before/after state, user-agent,
-- and actor-role capture; provides fn_log_admin_action() for callers; locks
-- down RLS to platform-admin reads only.
-- ============================================================================

ALTER TABLE public.admin_audit_log
  ADD COLUMN IF NOT EXISTS before_state jsonb,
  ADD COLUMN IF NOT EXISTS after_state jsonb,
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS actor_role text,
  ADD COLUMN IF NOT EXISTS request_id text;

CREATE INDEX IF NOT EXISTS admin_audit_log_admin_user_idx
  ON public.admin_audit_log (admin_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_log_action_idx
  ON public.admin_audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_log_target_idx
  ON public.admin_audit_log (target_type, target_id, created_at DESC);

-- ── RLS: admin-only reads. Service role writes (BYPASSRLS). ──
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_audit_log_admin_select ON public.admin_audit_log;
CREATE POLICY admin_audit_log_admin_select
  ON public.admin_audit_log FOR SELECT TO authenticated
  USING (public.fn_is_platform_admin());
-- Block all client-side writes; only service_role can insert via the RPC below.
DROP POLICY IF EXISTS admin_audit_log_no_client_writes ON public.admin_audit_log;
-- (no INSERT/UPDATE/DELETE policy — therefore default deny for non-bypassrls roles)

-- ── fn_log_admin_action — single entry point for all admin-mutation logging ──
CREATE OR REPLACE FUNCTION public.fn_log_admin_action(
  p_admin_user_id uuid,
  p_action text,
  p_target_type text DEFAULT NULL,
  p_target_id text DEFAULT NULL,
  p_details jsonb DEFAULT '{}'::jsonb,
  p_before_state jsonb DEFAULT NULL,
  p_after_state jsonb DEFAULT NULL,
  p_ip_address text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_request_id text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_role text;
BEGIN
  IF p_admin_user_id IS NULL THEN
    RAISE EXCEPTION 'admin_user_id required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_action IS NULL OR length(trim(p_action)) = 0 THEN
    RAISE EXCEPTION 'action required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT role INTO v_role FROM public.profiles WHERE id = p_admin_user_id;

  INSERT INTO public.admin_audit_log (
    admin_user_id, action, target_type, target_id,
    details, before_state, after_state,
    ip_address, user_agent, actor_role, request_id
  ) VALUES (
    p_admin_user_id, p_action, p_target_type, p_target_id,
    COALESCE(p_details, '{}'::jsonb), p_before_state, p_after_state,
    p_ip_address, p_user_agent, v_role, p_request_id
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_log_admin_action(uuid,text,text,text,jsonb,jsonb,jsonb,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_log_admin_action(uuid,text,text,text,jsonb,jsonb,jsonb,text,text,text) TO service_role;

COMMENT ON FUNCTION public.fn_log_admin_action(uuid,text,text,text,jsonb,jsonb,jsonb,text,text,text) IS
  'Phase 6.1.8 — single entry point for admin-action audit logging. SECURITY DEFINER, service-role only. Captures actor, action, target, before/after diff, IP, UA, request id, and snapshots actor role at log time.';
COMMENT ON TABLE public.admin_audit_log IS
  'Phase 6.1.8 — append-only audit log for privileged admin actions. Reads restricted to platform admins; writes via fn_log_admin_action only.';
