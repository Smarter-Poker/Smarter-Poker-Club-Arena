-- 20261016042212_club_invite_notify_actor_and_first_redemption.sql
--
-- Version reserved by scripts/new-migration.mjs.
--
-- WHAT THIS CHANGES, AND WHY (final audit of Share & Invite, 2026-10-16):
--
-- fn_club_invite_notify
--   * Sets notifications.actor_id to the invited player, so the feed shows
--     their avatar instead of guessing from the title, and the push mirror's
--     device tag collapses repeats from one player.
--   * club_invite_signup is a bell row only (data._push suppresses the push
--     mirror). A signup is not phone-verified yet, so throwaway accounts can
--     no longer buzz an inviter's phone. Verified and joined still push.
--
-- fn_redeem_club_invite_code
--   20261016040136 stopped re-runs from inflating "joined", but it also
--   stopped recording a FIRST redemption that left the member pending with
--   no upline (inviter departed, owner approval still required, or an owner
--   invite with nothing above). The first redemption of a join in progress
--   (member pending, or created within the hour) now counts; re-runs and a
--   long-standing member redeeming a code still record nothing.
--
-- Function bodies only. One transaction (club-arena CLAUDE.md, production DDL
-- policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_club_invite_notify(
  p_user_id uuid, p_type text, p_title text, p_message text, p_action_url text, p_data jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_data  jsonb := COALESCE(p_data, '{}'::jsonb);
  v_actor uuid;
BEGIN
  IF p_user_id IS NULL THEN RETURN; END IF;
  -- The invited player is the actor: the feed shows their avatar, and the
  -- push mirror collapses repeats from the same player into one device tag.
  BEGIN
    v_actor := NULLIF(v_data->>'referee_id', '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;
  -- A signup is not yet phone-verified, so it is a bell row only. Throwaway
  -- accounts cannot buzz an inviter's phone; the verified and joined notices,
  -- which a phone stands behind, still push.
  IF p_type = 'club_invite_signup' THEN
    v_data := v_data || jsonb_build_object('_push', 'suppressed_unverified');
  END IF;
  INSERT INTO public.notifications (user_id, actor_id, type, title, message, data, action_url, read, is_read)
  VALUES (p_user_id, v_actor, p_type, p_title, p_message, v_data, p_action_url, false, false);
EXCEPTION WHEN OTHERS THEN
  -- A notification is never allowed to undo a signup, a verification or a join.
  RAISE WARNING 'fn_club_invite_notify(%) failed: %', p_type, SQLERRM;
END $$;

-- Internal helper: only the invite functions (SECURITY DEFINER) call it.
REVOKE ALL ON FUNCTION public.fn_club_invite_notify(uuid, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_invite_notify(uuid, text, text, text, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_redeem_club_invite_code(p_club_id uuid, p_user_id uuid, p_referral_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_caller            uuid := auth.uid();
  v_code              text := btrim(coalesce(p_referral_code, ''));
  v_inviter           record;
  v_inviter_member    record;
  v_member            record;
  v_effective_agent   uuid;
  v_is_agent          boolean;
  v_agent_name        text;
  v_new_status        text;
  v_attr              record;
  v_inviter_settled   boolean;
  v_club_name         text;
  v_link_code         text;
  v_joiner_alias      text;
  v_code_inviter      uuid;
  v_prev_status       text;
  v_prev_agent        uuid;
  v_prev_invited      uuid;
  v_changed           boolean;
BEGIN
  -- ── Authorization ────────────────────────────────────────────────────────
  IF v_caller IS NOT NULL AND v_caller <> p_user_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_your_membership',
                              'error', 'You can only redeem an invite for yourself.');
  END IF;

  IF v_code = '' THEN
    RETURN jsonb_build_object('success', false, 'code', 'empty_code',
                              'error', 'No referral code supplied.');
  END IF;

  -- ── 0. First link wins ───────────────────────────────────────────────────
  -- A player who arrived through an attributed invite belongs to THAT inviter,
  -- whatever ?ref= a later link carries.
  SELECT p.id INTO v_code_inviter
    FROM profiles p
   WHERE p.player_number = v_code
      OR (v_code ~ '^[0-9]+$' AND p.player_number ~ '^[0-9]+$'
          AND p.player_number::bigint = v_code::bigint)
      OR (v_code ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND p.id = v_code::uuid)
   LIMIT 1;

  -- An unjoined attribution lapses after 30 days, as it does everywhere else.
  DELETE FROM club_invite_attributions
   WHERE user_id = p_user_id AND club_id = p_club_id
     AND status IN ('signed_up', 'verified')
     AND claimed_at <= now() - interval '30 days';

  SELECT * INTO v_attr FROM club_invite_attributions
   WHERE user_id = p_user_id AND club_id = p_club_id
   FOR UPDATE;

  -- A self-referral block binds only the inviter it was raised against. A
  -- different inviter's code places the player normally.
  IF v_attr.id IS NOT NULL AND v_attr.status = 'blocked'
     AND v_code_inviter IS NOT NULL AND v_code_inviter <> v_attr.inviter_id THEN
    DELETE FROM club_invite_attributions WHERE id = v_attr.id;
    SELECT * INTO v_attr FROM club_invite_attributions
     WHERE user_id = p_user_id AND club_id = p_club_id;
  END IF;

  IF v_attr.id IS NOT NULL AND v_attr.status = 'blocked' THEN
    -- A refused self-referral neither admits nor places. The player keeps the
    -- membership exactly as fn_join_club made it (pending clubs stay pending
    -- for the owner).
    SELECT * INTO v_member FROM club_members WHERE club_id = p_club_id AND user_id = p_user_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'not_a_member',
                                'error', 'User is not a member of this club.');
    END IF;
    RETURN jsonb_build_object('success', true, 'status', v_member.status,
                              'agent_id', v_member.agent_id, 'referral_skipped', v_attr.block_reason);
  END IF;

  -- ── 1. Resolve the inviter ───────────────────────────────────────────────
  IF v_attr.id IS NOT NULL THEN
    SELECT p.id, p.username, p.player_number INTO v_inviter FROM profiles p WHERE p.id = v_attr.inviter_id;
  ELSE
    SELECT p.id, p.username, p.player_number INTO v_inviter FROM profiles p WHERE p.id = v_code_inviter;
  END IF;

  IF v_inviter.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'unknown_inviter',
                              'error', 'Invalid referral code.');
  END IF;

  IF v_inviter.id = p_user_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'self_referral',
                              'error', 'You cannot invite yourself.');
  END IF;

  -- ── 2. Inviter standing ──────────────────────────────────────────────────
  -- An inviter who has left the club or been suspended no longer fails the
  -- join (Dan 2026-10-15): the player is routed to the club owner instead. Such
  -- an invite does not ADMIT on its own, though - the owner approves.
  SELECT * INTO v_inviter_member
    FROM club_members
   WHERE club_id = p_club_id AND user_id = v_inviter.id;

  v_inviter_settled := FOUND AND v_inviter_member.status IN ('active', 'approved', 'automatic');

  -- ── 3. Effective upline ──────────────────────────────────────────────────
  IF v_inviter_settled THEN
    SELECT true INTO v_is_agent
      FROM agents
     WHERE club_id = p_club_id AND user_id = v_inviter.id AND status = 'active';

    IF coalesce(v_is_agent, false) THEN
      v_effective_agent := v_inviter.id;
    ELSE
      v_effective_agent := v_inviter_member.agent_id;
    END IF;
  ELSE
    v_effective_agent := NULL;   -- directly under the club owner
  END IF;

  -- ── 4. The joining user must already have a membership row ───────────────
  SELECT * INTO v_member
    FROM club_members
   WHERE club_id = p_club_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_a_member',
                              'error', 'User is not a member of this club.');
  END IF;

  IF v_member.status NOT IN ('active', 'approved', 'automatic', 'pending') THEN
    RETURN jsonb_build_object('success', false, 'code', 'membership_blocked',
                              'error', 'This membership cannot be activated.');
  END IF;

  -- ── 5. Attach and admit ──────────────────────────────────────────────────
  v_new_status := CASE WHEN v_member.status = 'pending' AND v_inviter_settled THEN 'active' ELSE v_member.status END;
  -- ca-commerce-admission: an invite admitting a PENDING member makes a NEW
  -- approved member (R2 4.3, D22). Shadow records and proceeds; enforced
  -- keeps the member pending for the owner instead.
  IF v_member.status = 'pending' AND v_new_status = 'active' THEN
    PERFORM public.fn_club_membership_lock(p_user_id);
    DECLARE
      v_ca_admission jsonb := public.fn_ca_commerce_admit('club', p_club_id, 'join_member', 'fn_redeem_club_invite_code', p_user_id);
    BEGIN
      IF NOT COALESCE((v_ca_admission->>'allowed')::boolean, true) THEN
        v_new_status := 'pending';
      END IF;
    END;
  END IF;

  v_prev_status := v_member.status;
  v_prev_agent  := v_member.agent_id;
  v_prev_invited := v_member.invited_by;

  UPDATE club_members
     SET agent_id   = coalesce(agent_id, v_effective_agent),
         invited_by = coalesce(invited_by, v_inviter.id),
         status     = v_new_status,
         updated_at = now()
   WHERE club_id = p_club_id AND user_id = p_user_id
  RETURNING * INTO v_member;

  -- ── 6. Re-derive the upline's player counts ──────────────────────────────
  IF v_member.agent_id IS NOT NULL THEN
    UPDATE agents
       SET total_players = (SELECT count(*) FROM club_members
                             WHERE agent_id = v_member.agent_id AND club_id = p_club_id),
           active_player_count = (SELECT count(*) FROM club_members
                                   WHERE agent_id = v_member.agent_id AND club_id = p_club_id
                                     AND status IN ('active', 'approved')),
           updated_at = now()
     WHERE club_id = p_club_id AND user_id = v_member.agent_id;
  END IF;

  -- ── 7. Record the join against the invite and tell the inviter ───────────
  -- Only a call that actually did something is a join: the first redemption
  -- of a join in progress (it sets invited_by on a member still pending or
  -- created within the hour), an admission of a pending member, or a
  -- placement of one who had no upline. A long-standing member redeeming a
  -- code for the first time is not a join. Re-running an invite for a settled
  -- member records nothing and notifies nobody. The first redemption counts
  -- even when nothing else moves: a member the owner must still approve, or
  -- one placed directly under an owner who has no upline above them.
  v_changed := (v_prev_invited IS NULL AND v_member.invited_by IS NOT NULL
                AND (v_prev_status = 'pending' OR v_member.created_at > now() - interval '1 hour'))
               OR (v_prev_status = 'pending' AND v_member.status <> 'pending')
               OR (v_prev_agent IS NULL AND v_member.agent_id IS NOT NULL)
               OR v_attr.id IS NOT NULL;
  SELECT code INTO v_link_code FROM club_invite_links
   WHERE club_id = p_club_id AND inviter_id = v_inviter.id;

  IF v_attr.id IS NOT NULL THEN
    UPDATE club_invite_attributions
       SET status = 'joined', joined_at = COALESCE(joined_at, now())
     WHERE id = v_attr.id AND status IN ('signed_up', 'verified');
  ELSIF v_changed THEN
    INSERT INTO club_invite_attributions (code, club_id, inviter_id, user_id, status, joined_at)
    VALUES (v_link_code, p_club_id, v_inviter.id, p_user_id, 'joined', now())
    ON CONFLICT (user_id, club_id) DO NOTHING;
  END IF;

  IF v_changed AND (v_attr.id IS NULL OR v_attr.status IN ('signed_up', 'verified')) THEN
    SELECT name INTO v_club_name FROM clubs WHERE id = p_club_id;
    SELECT COALESCE(NULLIF(btrim(alias), ''), NULLIF(btrim(username), ''), 'A New Player') INTO v_joiner_alias FROM profiles WHERE id = p_user_id;
    PERFORM public.fn_club_invite_notify(
      v_inviter.id, 'club_invite_joined',
      CASE WHEN v_member.status = 'pending' THEN 'Your Invite Requested To Join' ELSE 'Your Invite Joined The Club' END,
      COALESCE(v_joiner_alias, 'A New Player')
        || CASE WHEN v_member.status = 'pending' THEN ' Requested To Join ' ELSE ' Joined ' END
        || COALESCE(v_club_name, 'Your Club') || ' From Your Invite.',
      '/hub/club-arena/clubs/' || p_club_id::text,
      jsonb_build_object('club_id', p_club_id, 'referee_id', p_user_id, 'agent_id', v_member.agent_id)
    );
  END IF;

  SELECT username INTO v_agent_name FROM profiles WHERE id = v_member.agent_id;

  RETURN jsonb_build_object(
    'success',     true,
    'status',      v_member.status,
    'agent_id',    v_member.agent_id,
    'agent_name',  v_agent_name,
    'inviter_id',  v_inviter.id,
    'inviter_name', v_inviter.username,
    'routed_to_owner', NOT v_inviter_settled
  );
END;
$function$;

COMMIT;
