CREATE OR REPLACE FUNCTION public.fn_create_agent(p_user_id uuid, p_club_id uuid, p_role text, p_parent_agent_id uuid, p_commission_rate numeric, p_player_rakeback_rate numeric, p_credit_limit numeric, p_is_prepaid boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_membership_user uuid; v_member_role text;
  v_parent_role text; v_parent_comm numeric; v_parent_rake numeric; v_parent_limit numeric;
  v_new_id uuid; v_role_res jsonb;
  v_is_staff boolean; v_comm numeric; v_rake numeric; v_prepaid boolean;
BEGIN
  IF p_user_id IS NULL OR p_club_id IS NULL THEN RETURN jsonb_build_object('success',false,'error','user and club required'); END IF;
  IF v_caller IS NULL THEN RETURN jsonb_build_object('success',false,'error','authentication required'); END IF;
  IF NOT EXISTS (SELECT 1 FROM clubs c WHERE c.id=p_club_id AND (c.owner_id=v_caller
     OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id=p_club_id AND cm.user_id=v_caller AND cm.role IN ('owner','co_owner','admin')))) THEN
    RETURN jsonb_build_object('success',false,'error','not authorized to manage this club''s agents'); END IF;
  IF p_role IS NULL OR p_role NOT IN ('super_agent','agent','sub_agent') THEN RETURN jsonb_build_object('success',false,'error','invalid role'); END IF;
  IF p_commission_rate IS NULL OR p_commission_rate < 0 OR p_commission_rate > 0.7 THEN RETURN jsonb_build_object('success',false,'error','commission rate must be 0-0.7'); END IF;
  IF p_player_rakeback_rate IS NULL OR p_player_rakeback_rate < 0 OR p_player_rakeback_rate > 0.5 THEN RETURN jsonb_build_object('success',false,'error','rakeback rate must be 0-0.5'); END IF;
  IF p_credit_limit IS NULL OR p_credit_limit < 0 THEN RETURN jsonb_build_object('success',false,'error','credit_limit must be >= 0'); END IF;
  IF EXISTS (SELECT 1 FROM agents WHERE user_id=p_user_id AND club_id=p_club_id) THEN RETURN jsonb_build_object('success',false,'error','already an agent in this club'); END IF;

  SELECT user_id, role INTO v_membership_user, v_member_role
    FROM club_members WHERE club_id=p_club_id AND user_id=p_user_id;

  -- Dan, 2026-08-31: "OWNERS AND CO OWNERS CAN AND SHOULD HAVE AGENT WALLETS,
  -- THAT WAS A MISTAKE."
  --
  -- PR #2132 refused outright here, on the reasoning that staff earn no
  -- rakeback so making one an agent is a demotion wearing a create button. That
  -- conflated two separate things. The agents row is BOTH the commission
  -- profile AND the agent wallet, and Dan's chip flow - main bank to agent
  -- wallet to agents and players - requires an owner or a co-owner to hold one.
  -- What they must not get is a rate, and what they must not lose is their
  -- title. Both are handled below instead of refusing the whole operation.
  v_is_staff := v_member_role IN ('owner','co_owner','admin');

  -- Owners keep earning (Dan, B-02, 2026-08-31). A co-owner and an admin do
  -- not, so their wallet is minted at zero rather than at whatever the caller
  -- typed; trg_agents_staff_earn_no_rakeback would zero it anyway, and doing it
  -- here means the row and the request agree instead of silently differing.
  IF v_member_role IN ('co_owner','admin') THEN
    v_comm := 0;
    v_rake := 0;
  ELSE
    v_comm := p_commission_rate;
    v_rake := p_player_rakeback_rate;
  END IF;

  -- Prepaid or a line, and how much. There is no third option, and the pair
  -- that means "can send nothing at all" is refused rather than stored.
  v_prepaid := COALESCE(p_is_prepaid, false);
  IF v_prepaid AND p_credit_limit <> 0 THEN
    RETURN jsonb_build_object('success',false,'error','a prepaid agent carries no credit line, so the limit must be 0');
  END IF;
  IF NOT v_prepaid AND p_credit_limit <= 0 THEN
    RETURN jsonb_build_object('success',false,'needs_funding',true,
      'error','choose prepaid, or give a credit limit greater than 0');
  END IF;

  IF p_parent_agent_id IS NOT NULL THEN
    SELECT role, commission_rate, player_rakeback_rate, credit_limit
      INTO v_parent_role, v_parent_comm, v_parent_rake, v_parent_limit
      FROM agents WHERE id=p_parent_agent_id;
    IF v_parent_role IS NULL THEN RETURN jsonb_build_object('success',false,'error','parent agent not found'); END IF;
    IF v_parent_role = 'sub_agent' THEN RETURN jsonb_build_object('success',false,'error','sub-agents cannot have sub-agents'); END IF;
    IF v_comm > v_parent_comm THEN RETURN jsonb_build_object('success',false,'error','commission rate cannot exceed parent rate'); END IF;
    IF v_rake > v_parent_rake THEN RETURN jsonb_build_object('success',false,'error','rakeback rate cannot exceed parent rate'); END IF;
    IF v_parent_limit IS NOT NULL AND p_credit_limit > v_parent_limit THEN
      RETURN jsonb_build_object('success',false,'error','credit limit cannot exceed parent agent limit'); END IF;
  END IF;

  INSERT INTO agents (user_id, club_id, membership_id, role, parent_agent_id, commission_rate, player_rakeback_rate, credit_limit, credit_used, is_prepaid)
  VALUES (p_user_id, p_club_id, COALESCE(v_membership_user, p_user_id), p_role, p_parent_agent_id, v_comm, v_rake, p_credit_limit, 0, v_prepaid)
  RETURNING id INTO v_new_id;

  -- THE TITLE SURVIVES THE WALLET. Giving an owner an agent wallet must not
  -- write 'agent' over 'owner' in club_members - that is a demotion nobody
  -- asked for, and fn_club_grantable_roles would refuse it anyway (an owner is
  -- never demotable through this door), so the whole create would fail with a
  -- confusing permission error. Only a player being made into an agent has a
  -- club role to change.
  IF NOT v_is_staff AND v_membership_user IS NOT NULL AND v_member_role IS DISTINCT FROM p_role THEN
    v_role_res := public.fn_club_set_member_role(
      p_club_id, p_user_id, p_role, v_caller, v_comm, v_rake, v_prepaid, p_credit_limit);
    IF NOT COALESCE((v_role_res ->> 'success')::boolean, false) THEN
      RETURN v_role_res;
    END IF;
  END IF;

  RETURN jsonb_build_object('success',true,'agent_id',v_new_id,
    'club_role_unchanged', v_is_staff, 'club_role', v_member_role);
END;
$function$;
