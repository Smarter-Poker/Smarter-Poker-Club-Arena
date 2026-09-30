-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721165919 "admin_update_agent_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0ca9577167b6a0b476a5633574ebba3b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Agent field updates (status/role/credit_limit/commission_rate) from the SPA
-- were writing directly to the service-role-write-only `agents` table, so they
-- silently no-op'd under RLS and returned false success. This SECURITY DEFINER
-- RPC applies them atomically after authorizing the caller as the agent's club
-- owner/admin. Keyed on agent_id (matches AgentService's methods). Only non-null
-- fields are applied.
CREATE OR REPLACE FUNCTION public.fn_admin_update_agent(
  p_agent_id uuid,
  p_status text DEFAULT NULL,
  p_role text DEFAULT NULL,
  p_credit_limit numeric DEFAULT NULL,
  p_commission_rate numeric DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_caller uuid := (SELECT auth.uid());
BEGIN
  IF p_agent_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent id required');
  END IF;
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication required');
  END IF;

  SELECT club_id INTO v_club_id FROM agents WHERE id = p_agent_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent not found');
  END IF;

  -- Authorize: caller must own or admin the agent's club.
  IF NOT EXISTS (
    SELECT 1 FROM clubs c
    WHERE c.id = v_club_id
      AND (
        c.owner_id = v_caller
        OR EXISTS (
          SELECT 1 FROM club_members cm
          WHERE cm.club_id = v_club_id AND cm.user_id = v_caller
            AND cm.role IN ('owner', 'co_owner', 'admin')
        )
      )
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to manage this club''s agents');
  END IF;

  IF p_status IS NOT NULL AND p_status NOT IN ('active', 'suspended', 'frozen') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid status');
  END IF;
  IF p_role IS NOT NULL AND p_role NOT IN ('super_agent', 'agent', 'sub_agent') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid role');
  END IF;
  IF p_credit_limit IS NOT NULL AND p_credit_limit < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'credit_limit must be >= 0');
  END IF;
  IF p_commission_rate IS NOT NULL AND (p_commission_rate < 0 OR p_commission_rate > 100) THEN
    RETURN jsonb_build_object('success', false, 'error', 'commission_rate out of range');
  END IF;

  UPDATE agents SET
    status = COALESCE(p_status, status),
    role = COALESCE(p_role, role),
    credit_limit = COALESCE(p_credit_limit, credit_limit),
    commission_rate = COALESCE(p_commission_rate, commission_rate)
  WHERE id = p_agent_id;

  RETURN jsonb_build_object('success', true, 'agent_id', p_agent_id);
END;
$function$;

DO $$
DECLARE r jsonb;
BEGIN
  SELECT fn_admin_update_agent(NULL) INTO r;
  IF (r->>'success') <> 'false' THEN RAISE EXCEPTION 'guard failed: %', r; END IF;
END $$;
