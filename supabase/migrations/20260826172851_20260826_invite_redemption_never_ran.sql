-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826172851; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════════
-- THE INVITE REDEMPTION RPC HAD NEVER RUN ONCE
--
-- `fn_redeem_club_invite_code` looked up the inviter with:
--
--     WHERE (p_referral_code ~ '^[0-9]+$' AND player_number = p_referral_code::int)
--        OR (p_referral_code ~ '-'        AND id::text = p_referral_code)
--
-- `profiles.player_number` is **text**, not integer. `text = integer` has no
-- operator in Postgres, so the statement fails to PLAN — which means the
-- function raised
--
--     42883: operator does not exist: text = integer
--
-- on EVERY call, for every code shape. Even a UUID referral code hit it: the
-- planner has to type-check the whole OR expression before the first row is
-- read, so the branch that would have matched never got the chance.
--
-- The client swallowed it. `AgentService.linkPlayerByReferral` treats any error
-- as "not an agent link" and returns `{ success: false }`, so the failure was
-- invisible: no downline was ever attached, and — because this function is also
-- what promotes an invited player from `pending` to `active` — nobody who
-- followed an invite link into an approval-gated club was ever let in. All
-- three live clubs have `requires_approval = true`, so that was everybody.
--
-- This rewrite fixes the cast and closes four holes found alongside it:
--
--   1. AUTHORIZATION. The old body trusted `p_user_id` from the client while
--      being SECURITY DEFINER. Any authenticated user could re-parent any
--      member of any club onto any agent, and flip them active. Now the caller
--      must be the user being redeemed (service_role, which has no auth.uid(),
--      still passes for server-side use).
--   2. SELF-REFERRAL. You could invite yourself and become your own inviter.
--   3. AN EXISTING DOWNLINE WAS OVERWRITTEN. A second invite link re-pointed a
--      player who already had an agent — including re-pointing them to NULL
--      when the new inviter had no upline. agent_id is now only filled when it
--      is empty.
--   4. STATUS LAUNDERING. `status = 'active'` was unconditional, so a banned or
--      removed member could re-admit themselves with any member's link. Only a
--      pending row is promoted now.
--
-- Rollback: the previous definition is in
-- supabase/migrations/20260826085000_fix_player_referral_redemption.sql —
-- re-running that file restores it verbatim (and restores the crash).
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'profiles'
         AND column_name = 'player_number') IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'profiles.player_number is no longer text - re-derive the comparison in this migration before applying it';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'club_members'
                    AND column_name = 'invited_by') THEN
    RAISE EXCEPTION 'club_members.invited_by is missing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_redeem_club_invite_code(
  p_club_id uuid,
  p_user_id uuid,
  p_referral_code text
)
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

  -- ── 1. Resolve the inviter ───────────────────────────────────────────────
  SELECT p.id, p.username, p.player_number
    INTO v_inviter
    FROM profiles p
   WHERE p.player_number = v_code
      OR (v_code ~ '^[0-9]+$' AND p.player_number ~ '^[0-9]+$'
          AND p.player_number::bigint = v_code::bigint)
      OR (v_code ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND p.id = v_code::uuid)
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'unknown_inviter',
                              'error', 'Invalid referral code.');
  END IF;

  IF v_inviter.id = p_user_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'self_referral',
                              'error', 'You cannot invite yourself.');
  END IF;

  -- ── 2. The inviter must be a settled member of this club ─────────────────
  SELECT * INTO v_inviter_member
    FROM club_members
   WHERE club_id = p_club_id AND user_id = v_inviter.id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'inviter_not_in_club',
                              'error', 'Inviter is not a member of this club.');
  END IF;

  IF v_inviter_member.status NOT IN ('active', 'approved') THEN
    RETURN jsonb_build_object('success', false, 'code', 'inviter_not_settled',
                              'error', 'Inviter is not an active member of this club.');
  END IF;

  -- ── 3. Effective upline ──────────────────────────────────────────────────
  SELECT true INTO v_is_agent
    FROM agents
   WHERE club_id = p_club_id AND user_id = v_inviter.id AND status = 'active';

  IF coalesce(v_is_agent, false) THEN
    v_effective_agent := v_inviter.id;
  ELSE
    v_effective_agent := v_inviter_member.agent_id;
  END IF;

  -- ── 4. The joining user must already have a membership row ───────────────
  SELECT * INTO v_member
    FROM club_members
   WHERE club_id = p_club_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_a_member',
                              'error', 'User is not a member of this club.');
  END IF;

  IF v_member.status NOT IN ('active', 'approved', 'pending') THEN
    RETURN jsonb_build_object('success', false, 'code', 'membership_blocked',
                              'error', 'This membership cannot be activated.');
  END IF;

  -- ── 5. Attach and admit ──────────────────────────────────────────────────
  v_new_status := CASE WHEN v_member.status = 'pending' THEN 'active' ELSE v_member.status END;

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

  SELECT username INTO v_agent_name FROM profiles WHERE id = v_member.agent_id;

  RETURN jsonb_build_object(
    'success',     true,
    'status',      v_member.status,
    'agent_id',    v_member.agent_id,
    'agent_name',  v_agent_name,
    'inviter_id',  v_inviter.id,
    'inviter_name', v_inviter.username
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_redeem_club_invite_code(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_redeem_club_invite_code(uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_redeem_club_invite_code(uuid, uuid, text) IS
  'Redeems a club invite/referral code for the CALLING user: attaches the upline agent (the inviter if they are an active agent, otherwise the inviter''s own agent), records invited_by, and promotes a pending membership to active. Never overwrites an existing agent_id and never changes a settled status. Fixed 2026-08-26: the previous body compared text player_number to an integer and therefore raised 42883 on every call since it was written.';

DO $$
DECLARE
  v_ok boolean;
BEGIN
  PERFORM 1 FROM profiles
   WHERE player_number = '12345'
      OR ('12345' ~ '^[0-9]+$' AND player_number ~ '^[0-9]+$'
          AND player_number::bigint = '12345'::bigint);

  SELECT (public.fn_redeem_club_invite_code(
            '00000000-0000-0000-0000-000000000000'::uuid,
            '00000000-0000-0000-0000-000000000000'::uuid,
            '')->>'code') = 'empty_code'
    INTO v_ok;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'fn_redeem_club_invite_code did not reject an empty code';
  END IF;
END $$;

