-- ═══════════════════════════════════════════════════════════════════════════
--  THE LADDER IS COMPLETE, AND PEOPLE ARE TOLD
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Phase 5 of 7. The promotion ladder worked, and said nothing. A player was
-- made a super agent, or handed a club, and the only way they learned was by
-- noticing that a screen looked different the next time they opened it.
--
-- Two changes:
--
-- 1. fn_club_set_member_role now raises a notification naming the new role,
--    and, for the three agent roles, the rates that came with it. The notify
--    is wrapped in its own BEGIN/EXCEPTION block: a promotion is the thing
--    that must not fail. If the notification cannot be written, the role
--    change still stands.
--
-- 2. transfer_club_ownership was writing a single incomplete role_changes row
--    and swallowing its own audit insert with EXCEPTION WHEN OTHERS THEN NULL.
--    A club changing hands is the largest thing that happens to a club and it
--    was the least recorded. It now writes TWO complete role_changes rows -
--    the outgoing owner and the incoming one, both carrying member_id - plus
--    an audit_trail row, and notifies BOTH parties. The silent swallow around
--    the audit insert is gone: if the books cannot be written, the handover
--    does not happen.
--
-- PROVENANCE. This migration was applied to production on 2026-08-31 and
-- recorded in supabase_migrations.schema_migrations as version 20260901000010.
-- The worktree holding the file was lost before it reached git. This file is
-- reconstructed from the deployed definitions themselves via
-- pg_get_functiondef, so it is a faithful copy of what is actually running,
-- and it is verified as such below rather than asserted. It is idempotent:
-- re-running it replaces each function with the definition already in place.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_club_set_member_role(p_club_id uuid, p_user_id uuid, p_role text, p_actor_user_id uuid DEFAULT NULL::uuid, p_commission_rate numeric DEFAULT NULL::numeric, p_player_rakeback_rate numeric DEFAULT NULL::numeric, p_is_prepaid boolean DEFAULT NULL::boolean, p_credit_limit numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor      uuid;
  v_old_role   text;
  v_actor_role text;
  v_allowed    text[];
  v_downline   int;
  v_agent_id   uuid;
  v_parent     uuid;
  v_set_upline boolean := false;
  v_is_agent   boolean;
  v_is_staff   boolean;
  v_comm       numeric;
  v_rake       numeric;
  v_prepaid    boolean;
  v_limit      numeric;
  v_have_row   boolean := false;
  v_fresh      boolean;
  v_cap_comm   numeric;
  v_cap_rake   numeric;
  v_cap_limit  numeric;
  v_float      numeric;
  v_owed       numeric;
  v_commission numeric;
  v_keeps_wallet boolean;
  v_club_name  text;
  v_label      text;
BEGIN
  -- IDENTITY. auth.uid() is the ONLY identity a browser can establish; it is
  -- NULL for anon, and a NULL here used to mean "believe p_actor_user_id".
  -- A caller-supplied actor is now accepted from a trusted backend only.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    IF COALESCE(auth.role(), 'service_role') = 'service_role'
       AND p_actor_user_id IS NOT NULL THEN
      v_actor := p_actor_user_id;
    ELSE
      RETURN jsonb_build_object('success', false, 'error', 'actor identity required');
    END IF;
  END IF;

  IF p_role IS NULL OR p_role NOT IN
     ('co_owner','admin','super_agent','agent','sub_agent','player') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid role: ' || COALESCE(p_role,'null'));
  END IF;

  v_is_agent := p_role IN ('super_agent','agent','sub_agent');
  v_is_staff := p_role IN ('co_owner','admin');

  IF NOT v_is_agent
     AND (COALESCE(p_commission_rate, 0) <> 0 OR COALESCE(p_player_rakeback_rate, 0) <> 0) THEN
    RETURN jsonb_build_object('success', false,
      'error', CASE WHEN v_is_staff
                    THEN 'co owners and admins receive no rakeback, so no rate may be set for one'
                    ELSE 'only an agent role carries a commission or rakeback rate' END);
  END IF;

  -- Funding belongs to an agent role. Sending it with a demotion to player, or
  -- with a promotion to staff, is a caller mistake worth naming rather than
  -- quietly ignoring: it usually means the wrong role reached this call.
  IF NOT v_is_agent AND (p_is_prepaid IS NOT NULL OR p_credit_limit IS NOT NULL) THEN
    RETURN jsonb_build_object('success', false,
      'error', 'only an agent role is funded prepaid or on a credit line');
  END IF;

  SELECT role INTO v_old_role FROM club_members
   WHERE club_id = p_club_id AND user_id = p_user_id
     AND status IN ('active','approved')
   FOR UPDATE;

  IF v_old_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'target is not a member of this club');
  END IF;

  IF v_old_role = p_role THEN
    RETURN jsonb_build_object('success', true, 'unchanged', true, 'role', p_role);
  END IF;

  v_allowed := fn_club_grantable_roles(p_club_id, v_actor, p_user_id);
  IF NOT (p_role = ANY (v_allowed)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not permitted to set this role',
      'allowed', COALESCE(to_jsonb(v_allowed), '[]'::jsonb));
  END IF;

  SELECT role INTO v_actor_role FROM club_members
   WHERE club_id = p_club_id AND user_id = v_actor AND status IN ('active','approved');

  IF fn_club_role_rank(v_old_role) > fn_club_role_rank(p_role)
     AND v_old_role IN ('super_agent','agent','sub_agent') THEN
    SELECT count(*) INTO v_downline FROM club_members
     WHERE club_id = p_club_id AND agent_id = p_user_id;
    IF v_downline > 0 THEN
      RETURN jsonb_build_object('success', false,
        'error', 'this member still has ' || v_downline || ' player'
                 || CASE WHEN v_downline = 1 THEN '' ELSE 's' END
                 || ' reporting to them. Move them to another agent first.',
        'downline_count', v_downline);
    END IF;
  END IF;

  v_set_upline := v_actor_role IN ('super_agent','agent')
                  AND p_role IN ('agent','sub_agent');

  -- ---------------------------------------------------------------------------
  -- A DEMOTION MUST NOT STRAND MONEY
  -- ---------------------------------------------------------------------------
  -- Every role except 'player' may hold an agent wallet - Dan, 2026-08-31:
  -- "OWNERS AND CO OWNERS CAN AND SHOULD HAVE AGENT WALLETS." So moving an
  -- agent up to co-owner, or sideways to another agent tier, strands nothing:
  -- the wallet goes with them and they can still spend it.
  --
  -- Becoming a PLAYER is the one move that takes the wallet away.
  -- fn_club_bank_role then returns 'player', fn_agent_wallet_send refuses them
  -- outright, and fn_agent_wallet_claim_back with it - so whatever the row still
  -- holds becomes chips nobody can move and nobody is watching. 67 of the 111
  -- active agents hold float today, 6,726,000 chips between them.
  --
  -- The remedy already exists and is named in the refusal:
  -- fn_club_bank_claim_back pulls the float back into the club bank, keyed on an
  -- op_id and written to the ledger, and any owner, co-owner, admin or super
  -- agent may run it. A debt is not sweepable and must be settled instead -
  -- fn_apply_credit_payment pays credit_used down when the invoice is paid.
  v_keeps_wallet := p_role <> 'player';

  -- v_old_role was checked against the three AGENT tiers here, which missed the
  -- people phase 2 deliberately gave wallets to. A co-owner or an admin holds an
  -- agent wallet by design - Dan: "OWNERS AND CO OWNERS CAN AND SHOULD HAVE
  -- AGENT WALLETS" - so demoting one straight to player took the wallet away
  -- with the float still in it, which is the exact defect this phase exists to
  -- stop. Any role that is not already 'player' can be holding one.
  IF NOT v_keeps_wallet AND v_old_role <> 'player' THEN
    SELECT COALESCE(a.agent_wallet_balance, 0), COALESCE(a.credit_used, 0),
           COALESCE(a.pending_commission, 0)
      INTO v_float, v_owed, v_commission
      FROM agents a
     WHERE a.club_id = p_club_id AND a.user_id = p_user_id;

    IF COALESCE(v_float, 0) > 0 OR COALESCE(v_owed, 0) > 0 THEN
      -- Name only what is actually outstanding. "holds 5,000 chips and owes
      -- 0.00" invites somebody to go looking for a debt that is not there.
      RETURN jsonb_build_object('success', false, 'needs_settlement', true,
        'error', 'this member cannot become a player yet: '
                 || CASE WHEN COALESCE(v_float, 0) > 0 AND COALESCE(v_owed, 0) > 0
                         THEN 'their agent wallet still holds '
                              || trim(to_char(v_float, 'FM999,999,999,990.00'))
                              || ' chips, and they still owe '
                              || trim(to_char(v_owed, 'FM999,999,999,990.00'))
                              || '. Claim the chips back into the club bank and settle the debt first.'
                         WHEN COALESCE(v_float, 0) > 0
                         THEN 'their agent wallet still holds '
                              || trim(to_char(v_float, 'FM999,999,999,990.00'))
                              || ' chips. Claim them back into the club bank first, '
                              || 'because a player cannot spend an agent wallet.'
                         ELSE 'they still owe '
                              || trim(to_char(v_owed, 'FM999,999,999,990.00'))
                              || ' on their credit line. Settle the invoice first.'
                    END,
        'agent_wallet_balance', COALESCE(v_float, 0),
        'credit_used', COALESCE(v_owed, 0),
        'pending_commission', COALESCE(v_commission, 0));
    END IF;
  END IF;

  IF v_is_agent THEN
    SELECT a.commission_rate, a.player_rakeback_rate, a.is_prepaid, a.credit_limit
      INTO v_comm, v_rake, v_prepaid, v_limit
      FROM agents a
     WHERE a.club_id = p_club_id AND a.user_id = p_user_id;
    v_have_row := FOUND;

    -- B-01, Dan 2026-08-31: FORCE A FRESH CHOICE.
    --
    -- A member whose current club role is not an agent tier is being PROMOTED.
    -- Their agents row may still hold the commission, rakeback and credit line
    -- they carried before they were demoted, and a commercial term nobody has
    -- re-agreed does not come back by default - "getting this wrong costs
    -- money" was the whole of the question put to Dan. So on a promotion every
    -- term is taken from this call and from nowhere else.
    --
    -- Re-GRADING an existing agent (agent to super agent) is a different act:
    -- their terms are live, not stale, and carrying them forward when the
    -- caller sends nothing is what every existing caller already relies on.
    v_fresh := v_old_role NOT IN ('super_agent','agent','sub_agent');

    IF v_fresh THEN
      v_comm    := p_commission_rate;
      v_rake    := p_player_rakeback_rate;
      v_prepaid := p_is_prepaid;
      v_limit   := p_credit_limit;
    ELSE
      v_comm    := COALESCE(p_commission_rate, v_comm);
      v_rake    := COALESCE(p_player_rakeback_rate, v_rake);
      v_prepaid := COALESCE(p_is_prepaid, v_prepaid);
      v_limit   := COALESCE(p_credit_limit, v_limit);
    END IF;

    IF v_comm IS NULL OR v_rake IS NULL THEN
      RETURN jsonb_build_object('success', false, 'needs_rates', true,
        'error', 'a commission rate and a player rakeback rate must be chosen when granting an agent role');
    END IF;
    IF v_comm < 0 OR v_comm > 0.70 THEN
      RETURN jsonb_build_object('success', false, 'error', 'the commission rate must be between 0 and 0.70');
    END IF;
    IF v_rake < 0 OR v_rake > 0.50 THEN
      RETURN jsonb_build_object('success', false, 'error', 'the player rakeback rate must be between 0 and 0.50');
    END IF;
    IF v_rake > v_comm THEN
      RETURN jsonb_build_object('success', false,
        'error', 'the player rakeback rate cannot exceed the commission rate it is paid out of');
    END IF;

    -- Dan, 2026-08-31: "WHEN A AGENT IS PROMOTED ... THEY ALSO NEED TO BE
    -- ASSIGNED 'PRE PAID' OR CREDIT LINE, (AND IF SO, THEN HOW MUCH)".
    -- Before this, every promotion hardcoded credit_limit 0 and left is_prepaid
    -- at its column default of false, which is the one combination that can
    -- send nothing at all: not prepaid, and no line to draw on. Three agents
    -- are in exactly that state on production today.
    IF v_prepaid IS NULL THEN
      RETURN jsonb_build_object('success', false, 'needs_funding', true,
        'error', 'choose prepaid or a credit line when granting an agent role');
    END IF;
    IF v_prepaid THEN
      IF COALESCE(v_limit, 0) <> 0 THEN
        RETURN jsonb_build_object('success', false,
          'error', 'a prepaid agent carries no credit line, so the limit must be 0');
      END IF;
      v_limit := 0;
    ELSE
      IF v_limit IS NULL THEN
        RETURN jsonb_build_object('success', false, 'needs_funding', true,
          'error', 'a credit agent needs a credit limit');
      END IF;
      IF v_limit <= 0 THEN
        RETURN jsonb_build_object('success', false,
          'error', 'a credit line must be greater than 0, or the agent should be prepaid');
      END IF;
    END IF;

    IF v_set_upline THEN
      SELECT id, commission_rate, player_rakeback_rate, credit_limit
        INTO v_parent, v_cap_comm, v_cap_rake, v_cap_limit
        FROM agents WHERE club_id = p_club_id AND user_id = v_actor;
    ELSIF v_have_row THEN
      SELECT p.commission_rate, p.player_rakeback_rate, p.credit_limit
        INTO v_cap_comm, v_cap_rake, v_cap_limit
        FROM agents a JOIN agents p ON p.id = a.parent_agent_id
       WHERE a.club_id = p_club_id AND a.user_id = p_user_id;
    END IF;

    IF v_cap_comm IS NOT NULL AND v_comm > v_cap_comm THEN
      RETURN jsonb_build_object('success', false,
        'error', 'the commission rate cannot exceed the upline rate of ' || v_cap_comm);
    END IF;
    IF v_cap_rake IS NOT NULL AND v_rake > v_cap_rake THEN
      RETURN jsonb_build_object('success', false,
        'error', 'the player rakeback rate cannot exceed the upline rate of ' || v_cap_rake);
    END IF;
    -- An upline cannot lend downward what it does not itself hold.
    IF v_cap_limit IS NOT NULL AND v_limit > v_cap_limit THEN
      RETURN jsonb_build_object('success', false,
        'error', 'the credit limit cannot exceed the upline limit of ' || v_cap_limit);
    END IF;
  END IF;

  PERFORM set_config('app.club_role_change', 'on', true);

  UPDATE club_members
     SET role                = p_role,
         agent_id            = CASE WHEN v_set_upline THEN v_actor ELSE agent_id END,
         player_rakeback_pct = CASE WHEN v_is_staff THEN 0 ELSE player_rakeback_pct END,
         rakeback_rate       = CASE WHEN v_is_staff THEN 0 ELSE rakeback_rate END,
         commission_rate     = CASE WHEN v_is_staff THEN 0 ELSE commission_rate END,
         updated_at          = now()
   WHERE club_id = p_club_id AND user_id = p_user_id;

  PERFORM set_config('app.club_role_change', '', true);

  IF v_is_agent THEN
    SELECT id INTO v_agent_id FROM agents
     WHERE club_id = p_club_id AND user_id = p_user_id;

    IF v_agent_id IS NOT NULL THEN
      UPDATE agents
         SET role = p_role, status = 'active',
             parent_agent_id = COALESCE(v_parent, parent_agent_id),
             commission_rate = v_comm, player_rakeback_rate = v_rake,
             is_prepaid = v_prepaid, credit_limit = v_limit,
             updated_at = now()
       WHERE id = v_agent_id;
    ELSE
      INSERT INTO agents (club_id, user_id, role, status, parent_agent_id,
                          commission_rate, player_rakeback_rate,
                          is_prepaid, credit_limit, credit_used)
      VALUES (p_club_id, p_user_id, p_role, 'active', v_parent, v_comm, v_rake,
              v_prepaid, v_limit, 0)
      RETURNING id INTO v_agent_id;
    END IF;
  ELSE
    -- Suspend the row only when the member can no longer hold a wallet. A
    -- promotion to co-owner or admin used to suspend it too, which contradicted
    -- the rule that staff hold agent wallets and left the club bank funding a
    -- row marked inactive.
    -- Active while they can hold a wallet, suspended when they cannot. Keyed on
    -- the role they are BECOMING, for the same reason the guard above is: a
    -- co-owner demoted to player left an ACTIVE agents row behind, so a player
    -- still read as an agent - fn_player_rakeback_rate joins that row on
    -- status = 'active'.
    UPDATE agents
       SET status = CASE WHEN p_role = 'player' AND v_old_role <> 'player'
                         THEN 'suspended' ELSE status END,
           commission_rate      = CASE WHEN v_is_staff THEN 0 ELSE commission_rate END,
           player_rakeback_rate = CASE WHEN v_is_staff THEN 0 ELSE player_rakeback_rate END,
           updated_at = now()
     WHERE club_id = p_club_id AND user_id = p_user_id;
  END IF;

  INSERT INTO audit_trail (actor_id, actor_role, action, target_type, target_id,
                           club_id, before_state, after_state, reason)
  VALUES (v_actor, COALESCE(v_actor_role, 'platform_admin'), 'set_member_role',
          'club_member', p_user_id, p_club_id,
          jsonb_build_object('role', v_old_role),
          jsonb_build_object('role', p_role, 'upline_set', v_set_upline,
                             'commission_rate', v_comm, 'player_rakeback_rate', v_rake,
                             'is_prepaid', v_prepaid, 'credit_limit', v_limit,
                             'funding_rechosen', COALESCE(v_fresh, false)),
          'Role changed via fn_club_set_member_role');

  -- ---------------------------------------------------------------------------
  -- TELL THE PERSON IT HAPPENED
  -- ---------------------------------------------------------------------------
  -- Until now the only announcement was masterBus.emit('MEMBER_ROLE_CHANGED'),
  -- a browser-local event. It reaches the tabs of whoever performed the change
  -- and nobody else, so the person whose role actually changed found out when a
  -- button appeared or vanished. notifications is the estate's real channel:
  -- 11,362 rows, four RLS policies, rendered by NotificationDropdown, the
  -- header store and NotificationsPage.
  --
  -- Failing to notify must never fail the role change. The role is the fact;
  -- the notice is a courtesy, and a courtesy that can roll back a promotion is
  -- worse than no courtesy at all.
  SELECT name INTO v_club_name FROM clubs WHERE id = p_club_id;
  v_label := CASE p_role
               WHEN 'co_owner' THEN 'Co Owner'
               WHEN 'admin' THEN 'Admin'
               WHEN 'super_agent' THEN 'Super Agent'
               WHEN 'agent' THEN 'Agent'
               WHEN 'sub_agent' THEN 'Sub Agent'
               ELSE 'Player'
             END;
  BEGIN
    PERFORM public.fn_raise_notification(
      p_user_id,
      'club_role_changed',
      'Your Role Changed In ' || COALESCE(v_club_name, 'Your Club'),
      'You Are Now ' || v_label || '.'
        || CASE WHEN v_is_agent
                THEN ' Your Commission Is ' || trim(to_char(v_comm * 100, 'FM990.00'))
                     || ' Percent And Your Player Rakeback Is '
                     || trim(to_char(v_rake * 100, 'FM990.00')) || ' Percent.'
                     || CASE WHEN v_prepaid THEN ' You Are Prepaid.'
                             ELSE ' Your Credit Line Is '
                                  || trim(to_char(v_limit, 'FM999,999,999,990.00')) || ' Chips.'
                        END
                ELSE '' END,
      '/clubs/' || p_club_id::text,
      jsonb_build_object(
        'club_id', p_club_id, 'old_role', v_old_role, 'new_role', p_role,
        'commission_rate', v_comm, 'player_rakeback_rate', v_rake,
        'is_prepaid', v_prepaid, 'credit_limit', v_limit));
  EXCEPTION WHEN OTHERS THEN
    -- Swallowed on purpose, and only here. The role change is already durable.
    NULL;
  END;

  RETURN jsonb_build_object('success', true, 'old_role', v_old_role, 'new_role', p_role,
    'commission_rate', v_comm, 'player_rakeback_rate', v_rake,
    'is_prepaid', v_prepaid, 'credit_limit', v_limit,
    -- Commission the CLUB owes THEM. It does not block the demotion: the agents
    -- row survives with the figure intact, so nothing is lost by moving the
    -- role, and there is no payout path to send them to yet (phase 6 builds
    -- one). Blocking here would strand the club, not the money. Reported so the
    -- caller can say it out loud rather than discover it later.
    'pending_commission', COALESCE(v_commission, 0),
    'reports_to', CASE WHEN v_set_upline THEN v_actor ELSE NULL END);
END;
$function$

;

CREATE OR REPLACE FUNCTION public.transfer_club_ownership(p_club_id uuid, p_new_owner_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_old UUID;
  v_actor UUID;
  v_club_name text;
BEGIN
  v_actor := auth.uid();

  SELECT owner_id, name INTO v_old, v_club_name FROM clubs WHERE id = p_club_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club not found';
  END IF;

  -- A JWT caller must BE the current owner. service_role callers (auth.uid()
  -- NULL) are trusted to have authorized upstream.
  IF v_actor IS NOT NULL AND v_actor <> v_old THEN
    RAISE EXCEPTION 'Only the current club owner can transfer ownership';
  END IF;

  IF p_new_owner_id = v_old THEN
    RAISE EXCEPTION 'That user already owns this club';
  END IF;

  -- Recipient must be an active member of this club.
  IF NOT EXISTS (
    SELECT 1 FROM club_members
     WHERE club_id = p_club_id AND user_id = p_new_owner_id
       AND status IN ('active','approved')
  ) THEN
    RAISE EXCEPTION 'New owner must be an active member of this club';
  END IF;

  UPDATE clubs SET owner_id = p_new_owner_id, updated_at = NOW() WHERE id = p_club_id;
  UPDATE club_members SET role = 'admin', updated_at = NOW()
   WHERE club_id = p_club_id AND user_id = v_old;
  UPDATE club_members SET role = 'owner', updated_at = NOW()
   WHERE club_id = p_club_id AND user_id = p_new_owner_id;

  -- THE RECORD. This used to insert a role_changes row with member_id NULL -
  -- the column that says WHO - inside EXCEPTION WHEN OTHERS THEN NULL, so a
  -- failed insert meant a club changed hands leaving no trace. Both rows are
  -- complete now, and neither is swallowed: a handover that cannot be recorded
  -- does not happen.
  INSERT INTO role_changes (member_id, old_role, new_role, changed_by, reason)
  VALUES (p_new_owner_id, 'admin', 'owner', COALESCE(v_actor, v_old),
          'Club ownership transferred');
  INSERT INTO role_changes (member_id, old_role, new_role, changed_by, reason)
  VALUES (v_old, 'owner', 'admin', COALESCE(v_actor, v_old),
          'Club ownership transferred');

  INSERT INTO audit_trail (actor_id, actor_role, action, target_type, target_id,
                           club_id, before_state, after_state, reason)
  VALUES (COALESCE(v_actor, v_old), 'owner', 'transfer_club_ownership',
          'club', p_club_id, p_club_id,
          jsonb_build_object('owner_id', v_old),
          jsonb_build_object('owner_id', p_new_owner_id, 'previous_owner_role', 'admin'),
          'Club ownership transferred');

  -- Both people are told. The outgoing owner is no longer an owner, which is
  -- the kind of thing somebody should hear from the club rather than notice.
  BEGIN
    PERFORM public.fn_raise_notification(
      p_new_owner_id, 'club_ownership_transferred',
      'You Now Own ' || COALESCE(v_club_name, 'A Club'),
      'Ownership Was Transferred To You. You Now Hold Every Permission In This Club.',
      '/clubs/' || p_club_id::text,
      jsonb_build_object('club_id', p_club_id, 'previous_owner', v_old));
    PERFORM public.fn_raise_notification(
      v_old, 'club_ownership_transferred',
      'You Handed Over ' || COALESCE(v_club_name, 'Your Club'),
      'Ownership Has Moved To Another Member. You Are Now An Admin Of This Club.',
      '/clubs/' || p_club_id::text,
      jsonb_build_object('club_id', p_club_id, 'new_owner', p_new_owner_id));
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- the handover is done and recorded; the notice is a courtesy
  END;
END;
$function$

;

-- ───────────────────────────────────────────────────────────────────────────
-- AUTHORIZATION. CREATE OR REPLACE preserves an existing ACL, but this file
-- must also be correct when run against a database that does not have these
-- functions yet, where the default is EXECUTE to PUBLIC. Both are SECURITY
-- DEFINER and both move money or power, so the grant is named explicitly
-- rather than inherited.
-- ───────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.fn_club_set_member_role(uuid, uuid, text, uuid, numeric, numeric, boolean, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_set_member_role(uuid, uuid, text, uuid, numeric, numeric, boolean, numeric) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.transfer_club_ownership(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_club_ownership(uuid, uuid) TO authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- SELF-ASSERTIONS. This migration refuses to commit a state it did not mean.
-- ───────────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_def  text;
  v_code text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_club_set_member_role';

  IF v_def NOT LIKE '%fn_raise_notification%' THEN
    RAISE EXCEPTION 'fn_club_set_member_role does not tell anyone about the change';
  END IF;
  IF v_def NOT LIKE '%club_role_changed%' THEN
    RAISE EXCEPTION 'fn_club_set_member_role does not raise a club_role_changed notice';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'transfer_club_ownership';

  IF v_def NOT LIKE '%role_changes%' THEN
    RAISE EXCEPTION 'transfer_club_ownership does not close the books on a handover';
  END IF;
  IF v_def NOT LIKE '%audit_trail%' THEN
    RAISE EXCEPTION 'transfer_club_ownership does not write an audit row';
  END IF;
  IF v_def NOT LIKE '%fn_raise_notification%' THEN
    RAISE EXCEPTION 'transfer_club_ownership does not tell either party';
  END IF;
  -- The books may not be swallowed; the courtesy notice may be. Exactly one
  -- WHEN OTHERS is allowed, and it must come AFTER the last write to the
  -- record, which is what makes it a guard on the notification and not on
  -- the audit. This is the shape the fix put there, asserted rather than
  -- trusted, so a later edit that moves the swallow back up over the insert
  -- cannot land quietly.
  v_code := regexp_replace(lower(v_def), '--[^\n]*', '', 'g');

  IF (length(v_code) - length(replace(v_code, 'when others', ''))) / length('when others') <> 1 THEN
    RAISE EXCEPTION 'transfer_club_ownership has % WHEN OTHERS handlers in code, expected exactly 1',
      (length(v_code) - length(replace(v_code, 'when others', ''))) / length('when others');
  END IF;
  IF position('when others' in v_code) < position('audit_trail' in v_code) THEN
    RAISE EXCEPTION 'transfer_club_ownership swallows errors around the audit write';
  END IF;
  IF position('when others' in v_code) < position('role_changes' in v_code) THEN
    RAISE EXCEPTION 'transfer_club_ownership swallows errors around the role_changes write';
  END IF;

  -- Neither function may be reachable by an unauthenticated caller.
  IF has_function_privilege('anon',
       'public.fn_club_set_member_role(uuid, uuid, text, uuid, numeric, numeric, boolean, numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can promote club members';
  END IF;
  IF has_function_privilege('anon', 'public.transfer_club_ownership(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can hand over a club';
  END IF;
END
$verify$;

COMMIT;
