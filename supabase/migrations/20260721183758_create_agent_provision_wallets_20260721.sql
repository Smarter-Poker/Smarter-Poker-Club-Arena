-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721183758 "create_agent_provision_wallets_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 13017914f2976c136265bb682dc06a67 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Task #52: fn_create_agent must provision the agent's BUSINESS/PROMO (+PLAYER)
-- wallets. A user promoted straight to agent otherwise has no such rows, and every
-- wallets write is RLS service-role-only so the client cannot create them itself.
-- Idempotent (ON CONFLICT DO NOTHING). Only the wallet-provisioning block is new;
-- the rest of the function is unchanged from the live definition.
CREATE OR REPLACE FUNCTION public.fn_create_agent(p_user_id uuid, p_club_id uuid, p_role text, p_parent_agent_id uuid, p_commission_rate numeric, p_player_rakeback_rate numeric, p_credit_limit numeric, p_is_prepaid boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_membership_user uuid;
  v_parent_role text;
  v_parent_comm numeric;
  v_parent_rake numeric;
  v_new_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'user and club required'); END IF;
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication required'); END IF;

  IF NOT EXISTS (
    SELECT 1 FROM clubs c WHERE c.id = p_club_id AND (
      c.owner_id = v_caller
      OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = p_club_id AND cm.user_id = v_caller
                 AND cm.role IN ('owner','co_owner','admin')))
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to manage this club''s agents'); END IF;

  IF p_role IS NULL OR p_role NOT IN ('super_agent','agent','sub_agent') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid role'); END IF;
  IF p_commission_rate IS NULL OR p_commission_rate < 0 OR p_commission_rate > 0.7 THEN
    RETURN jsonb_build_object('success', false, 'error', 'commission rate must be 0-0.7'); END IF;
  IF p_player_rakeback_rate IS NULL OR p_player_rakeback_rate < 0 OR p_player_rakeback_rate > 0.5 THEN
    RETURN jsonb_build_object('success', false, 'error', 'rakeback rate must be 0-0.5'); END IF;
  IF p_credit_limit IS NULL OR p_credit_limit < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'credit_limit must be >= 0'); END IF;

  IF EXISTS (SELECT 1 FROM agents WHERE user_id = p_user_id AND club_id = p_club_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'already an agent in this club'); END IF;

  IF p_parent_agent_id IS NOT NULL THEN
    SELECT role, commission_rate, player_rakeback_rate
      INTO v_parent_role, v_parent_comm, v_parent_rake
    FROM agents WHERE id = p_parent_agent_id;
    IF v_parent_role IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'parent agent not found'); END IF;
    IF v_parent_role = 'sub_agent' THEN
      RETURN jsonb_build_object('success', false, 'error', 'sub-agents cannot have sub-agents'); END IF;
    IF p_commission_rate > v_parent_comm THEN
      RETURN jsonb_build_object('success', false, 'error', 'commission rate cannot exceed parent rate'); END IF;
    IF p_player_rakeback_rate > v_parent_rake THEN
      RETURN jsonb_build_object('success', false, 'error', 'rakeback rate cannot exceed parent rate'); END IF;
  END IF;

  SELECT user_id INTO v_membership_user FROM club_members WHERE club_id = p_club_id AND user_id = p_user_id;

  INSERT INTO agents (user_id, club_id, membership_id, role, parent_agent_id,
                      commission_rate, player_rakeback_rate, credit_limit, is_prepaid)
  VALUES (p_user_id, p_club_id, COALESCE(v_membership_user, p_user_id), p_role, p_parent_agent_id,
          p_commission_rate, p_player_rakeback_rate, p_credit_limit, COALESCE(p_is_prepaid, false))
  RETURNING id INTO v_new_id;

  IF v_membership_user IS NOT NULL THEN
    UPDATE club_members SET role = p_role WHERE club_id = p_club_id AND user_id = p_user_id;
  END IF;

  -- NEW: provision the agent's wallets. Agents settle commissions through BUSINESS
  -- and receive promo chips in PROMO. Idempotent so an existing player's wallets are
  -- left untouched.
  INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
  SELECT p_user_id, wt, 0, 0
  FROM unnest(ARRAY['PLAYER','BUSINESS','PROMO']::text[]) AS wt
  ON CONFLICT (user_id, wallet_type) DO NOTHING;

  RETURN jsonb_build_object('success', true, 'agent_id', v_new_id);
END;
$function$;
