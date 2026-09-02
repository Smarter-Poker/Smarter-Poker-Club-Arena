-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX PLAYER REFERRAL REDEMPTION
-- If a normal player shares their link, we must roll the referral up to THEIR
-- upline agent, while still tracking them as the direct inviter.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_redeem_club_invite_code(p_club_id uuid, p_user_id uuid, p_referral_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_inviter_profile record;
  v_inviter_member record;
  v_effective_agent_id uuid;
  v_agent record;
  v_member record;
BEGIN
  -- 1. Find the inviter profile by referral code (player_number or uuid)
  SELECT *
    INTO v_inviter_profile
    FROM profiles
   WHERE (p_referral_code ~ '^[0-9]+$' AND player_number = p_referral_code::int)
      OR (p_referral_code ~ '-' AND id::text = p_referral_code);

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid referral code.');
  END IF;

  -- 2. Ensure inviter is in the club
  SELECT * INTO v_inviter_member FROM club_members
   WHERE club_id = p_club_id AND user_id = v_inviter_profile.id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Inviter is not a member of this club.');
  END IF;

  -- 3. Determine effective agent
  -- Is the inviter an active agent themselves?
  SELECT * INTO v_agent FROM agents
   WHERE club_id = p_club_id AND user_id = v_inviter_profile.id AND status = 'active';

  IF FOUND THEN
    v_effective_agent_id := v_inviter_profile.id;
  ELSE
    -- If not an agent, use the inviter's upline agent
    v_effective_agent_id := v_inviter_member.agent_id;
  END IF;

  -- 4. Ensure the joining user is a member (even if pending)
  SELECT * INTO v_member FROM club_members
   WHERE club_id = p_club_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'User is not a member of this club.');
  END IF;

  -- 5. Link them to the agent/inviter and make them active!
  UPDATE club_members
     SET agent_id = v_effective_agent_id,
         invited_by = v_inviter_profile.id,
         status = 'active',
         updated_at = now()
   WHERE club_id = p_club_id AND user_id = p_user_id;

  -- 6. Sync agent player counts if an agent was attached
  IF v_effective_agent_id IS NOT NULL THEN
    UPDATE agents
       SET total_players = (SELECT count(*) FROM club_members WHERE agent_id = v_effective_agent_id AND club_id = p_club_id),
           active_player_count = (SELECT count(*) FROM club_members WHERE agent_id = v_effective_agent_id AND club_id = p_club_id AND status IN ('active', 'approved')),
           updated_at = now()
     WHERE club_id = p_club_id AND user_id = v_effective_agent_id;
  END IF;

  -- 7. Return success
  RETURN jsonb_build_object('success', true);
END;
$function$;
