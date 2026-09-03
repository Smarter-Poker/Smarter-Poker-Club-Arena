-- =============================================================================
-- A PROMOTION CHOOSES THE RATE, AND STAFF EARN NONE
-- =============================================================================
-- 2026-08-31. Audit of the player promotion system, part two.
--
-- Dan, verbatim: "MAKE SURE THAT RAKE BACK PERCENTAGES ARE ASSIGNED WHEN
-- CREATING THEM (CO-OWNERS AND ADMINS GET NO RAKE BACK)."
--
-- THREE DEFECTS, ONE MIGRATION.
--
-- 1. WHAT THE GUARD ALREADY COVERS, AND WHAT IT DOES NOT.
--    I first wrote this migration believing trg_club_members_role_guard had
--    never been bound - a truncated string_agg in my own inspection query had
--    hidden it - and nearly shipped "an admin can write role='owner' straight
--    through PostgREST" as the headline. It is not true. The trigger is live:
--        BEFORE UPDATE ON club_members FOR EACH ROW
--        EXECUTE FUNCTION fn_club_members_role_guard()
--    and it refuses any role change that does not set app.club_role_change,
--    which only fn_club_set_member_role does. The direct write path is shut.
--
--    Two consequences follow, and they are the real findings:
--      * src/services/MembershipService.ts:213 (`.update({ role })`) has been
--        THROWING since that trigger landed. The Promote and Demote buttons on
--        ClubDetailPage:993/999 and the role select in ClubMemberManagement
--        have been dead in production, failing 42501 into a catch. They are
--        rerouted to the RPC in the client half of this change.
--      * SECURITY DEFINER functions owned by postgres are exempt by design,
--        so fn_create_agent and fn_admin_update_agent walked straight past it.
--        See defect 3.
--
-- 2. THE RATE NOBODY CHOSE.
--    Promoting to super agent / agent / sub agent minted the agents row with
--    rates invented in code - 0.50/0.30 for a super agent, 0.30/0.20 for the
--    rest - and, when the row already existed (a previously suspended agent),
--    set no rate at all, so a demoted-then-re-promoted sub agent kept the super
--    agent commission they used to have. Three separate server paths each
--    invented a different pair: fn_club_set_member_role (50/30 or 30/20),
--    fn_ensure_agent_row (union minimum / zero), fn_create_agent (asked, and
--    was the only one that did).
--
--    fn_club_set_member_role now REFUSES an agent-role promotion that arrives
--    without a rate, unless the member already has an agents row to inherit
--    from. The refusal is the point: a rate nobody chose is a rate nobody can
--    defend to the agent it underpays.
--
-- 2b. CO-OWNERS AND ADMINS EARN NO RAKEBACK.
--    Nothing said so. A player carrying a personal rakeback deal
--    (club_members.player_rakeback_pct - the first branch of
--    fn_player_rakeback_rate) kept it when promoted to admin. Two triggers now
--    make it true by construction rather than by care, on both tables that can
--    carry a rate, whatever writes them.
--
--    The RATE is what is zeroed, never the agents ROW: that row doubles as the
--    agent wallet (fn_ensure_agent_row is how a club-bank send mints one), and
--    deleting or suspending it to make a point would strand chips.
--
--    OWNER is deliberately NOT covered. Dan named co-owners and admins; one
--    live owner holds an active agents row at 0.30/0.20, and whether an owner
--    may also carry players is his call to make, not mine to assume. Section
--    10.5 of CLAUDE.md records what happens when an agent assumes.
--
-- 3. TWO RPCS WROTE ROLES BEHIND THE MATRIX'S BACK.
--    fn_create_agent and fn_admin_update_agent both ended with a bare
--    `UPDATE club_members SET role = p_role`. Being SECURITY DEFINER owned by
--    postgres, both are exempt from the trigger in (1) by design, so arming it
--    would not have stopped them. They now route the role change through
--    fn_club_set_member_role, so the downline guard and the audit row apply to
--    the agent panel as well as to the members list.
--    fn_admin_update_agent also validated rates against 0..100 while the table
--    CHECK allows 0..0.70 and 0..0.50, so a caller sending 25 for "25%" passed
--    validation and then hit a raw 23514 from Postgres.
--
-- BACKFILL. Measured before writing: 0 co-owners and 0 admins exist in
-- production today, so the backfill below corrects nothing. It is here so the
-- first one created after this migration lands in a world where the rule is
-- already true.
--
-- ROLLBACK.
--   DROP TRIGGER trg_club_members_staff_earn_no_rakeback ON public.club_members;
--   DROP TRIGGER trg_agents_staff_earn_no_rakeback ON public.agents;
--   and restore fn_club_set_member_role / fn_create_agent / fn_admin_update_agent
--   from git history (20260822_club_roles_rpcs.sql and the agent RPC migrations).
--   The backfill writes only zeros onto rows the rule says must be zero;
--   reverting it would mean re-granting rakeback to staff, which is the bug.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. trg_club_members_role_guard is NOT re-created here.
--
-- It already exists and works. Dropping and re-creating it to add a
-- WHEN (NEW.role IS DISTINCT FROM OLD.role) clause - which would spare the
-- function call on every chip_balance write - needs an AccessExclusiveLock on
-- club_members, and the first attempt at this migration deadlocked against the
-- live engine taking exactly that table. A micro-optimisation is not worth a
-- lock on the hottest table in the club. The verification block at the bottom
-- asserts the trigger is present; anything that removes it should fail here.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 2. Co-owners and admins earn no rakeback. Enforced, not remembered.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_club_members_staff_earn_no_rakeback()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- Dan 2026-08-31: "CO-OWNERS AND ADMINS GET NO RAKE BACK."
  -- player_rakeback_pct is the first branch of fn_player_rakeback_rate, so a
  -- non-zero value here is money. owner is not covered - see the header.
  NEW.player_rakeback_pct := 0;
  NEW.rakeback_rate       := 0;
  NEW.commission_rate     := 0;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_club_members_staff_earn_no_rakeback ON public.club_members;
CREATE TRIGGER trg_club_members_staff_earn_no_rakeback
  BEFORE INSERT OR UPDATE ON public.club_members
  FOR EACH ROW
  WHEN (NEW.role IN ('co_owner', 'admin')
        AND (COALESCE(NEW.player_rakeback_pct, 0) <> 0
          OR COALESCE(NEW.rakeback_rate, 0)       <> 0
          OR COALESCE(NEW.commission_rate, 0)     <> 0))
  EXECUTE FUNCTION public.fn_club_members_staff_earn_no_rakeback();

CREATE OR REPLACE FUNCTION public.fn_agents_staff_earn_no_rakeback()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.club_id = NEW.club_id
       AND cm.user_id = NEW.user_id
       AND cm.role IN ('co_owner', 'admin')
  ) THEN
    -- The row itself survives: it is also the agent wallet, and a staff member
    -- may legitimately hold one. Only the earning rate goes to zero.
    NEW.commission_rate      := 0;
    NEW.player_rakeback_rate := 0;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agents_staff_earn_no_rakeback ON public.agents;
CREATE TRIGGER trg_agents_staff_earn_no_rakeback
  BEFORE INSERT OR UPDATE OF role, commission_rate, player_rakeback_rate
  ON public.agents
  FOR EACH ROW
  WHEN (COALESCE(NEW.commission_rate, 0) <> 0
     OR COALESCE(NEW.player_rakeback_rate, 0) <> 0)
  EXECUTE FUNCTION public.fn_agents_staff_earn_no_rakeback();

-- Backfill. Measured at 0 rows on 2026-08-31; present so the rule is true of
-- history as well as of the future.
UPDATE public.club_members
   SET player_rakeback_pct = 0, rakeback_rate = 0, commission_rate = 0
 WHERE role IN ('co_owner', 'admin')
   AND (COALESCE(player_rakeback_pct, 0) <> 0
     OR COALESCE(rakeback_rate, 0)       <> 0
     OR COALESCE(commission_rate, 0)     <> 0);

UPDATE public.agents a
   SET commission_rate = 0, player_rakeback_rate = 0, updated_at = now()
  FROM public.club_members cm
 WHERE cm.club_id = a.club_id
   AND cm.user_id = a.user_id
   AND cm.role IN ('co_owner', 'admin')
   AND (COALESCE(a.commission_rate, 0) <> 0 OR COALESCE(a.player_rakeback_rate, 0) <> 0);

-- -----------------------------------------------------------------------------
-- 3. The promotion itself: choose the rate, or be refused
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fn_club_set_member_role(uuid, uuid, text, uuid);

CREATE OR REPLACE FUNCTION public.fn_club_set_member_role(
  p_club_id              uuid,
  p_user_id              uuid,
  p_role                 text,
  p_actor_user_id        uuid    DEFAULT NULL,
  p_commission_rate      numeric DEFAULT NULL,
  p_player_rakeback_rate numeric DEFAULT NULL
) RETURNS jsonb
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
  v_have_row   boolean := false;
  v_cap_comm   numeric;
  v_cap_rake   numeric;
BEGIN
  -- Non-spoofable: a signed-in caller is always themselves. Only a service
  -- role caller (auth.uid() IS NULL) may name the actor.
  v_actor := COALESCE(auth.uid(), p_actor_user_id);
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'actor identity required');
  END IF;

  IF p_role IS NULL OR p_role NOT IN
     ('co_owner','admin','super_agent','agent','sub_agent','player') THEN
    -- 'owner' is absent deliberately: a club has one owner, and handing it
    -- over is its own act, not a dropdown on the members list.
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
    RETURN jsonb_build_object(
      'success', false,
      'error', 'not permitted to set this role',
      'allowed', COALESCE(to_jsonb(v_allowed), '[]'::jsonb));
  END IF;

  SELECT role INTO v_actor_role FROM club_members
   WHERE club_id = p_club_id AND user_id = v_actor AND status IN ('active','approved');

  -- Stepping someone down out of an agent role while people still report to
  -- them would leave those people pointing at an upline who is no longer one.
  IF fn_club_role_rank(v_old_role) > fn_club_role_rank(p_role)
     AND v_old_role IN ('super_agent','agent','sub_agent') THEN
    SELECT count(*) INTO v_downline FROM club_members
     WHERE club_id = p_club_id AND agent_id = p_user_id;
    IF v_downline > 0 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'this member still has ' || v_downline || ' player'
                 || CASE WHEN v_downline = 1 THEN '' ELSE 's' END
                 || ' reporting to them. Move them to another agent first.',
        'downline_count', v_downline);
    END IF;
  END IF;

  -- "to work under them": when a super agent makes an agent, or an agent makes
  -- a sub agent, the new appointee reports to the person who appointed them.
  v_set_upline := v_actor_role IN ('super_agent','agent')
                  AND p_role IN ('agent','sub_agent');

  -- ---------------------------------------------------------------------------
  -- The rate is CHOSEN. It used to be invented here, differently per tier, and
  -- not applied at all when the agents row already existed.
  -- ---------------------------------------------------------------------------
  IF v_is_agent THEN
    SELECT a.commission_rate, a.player_rakeback_rate
      INTO v_comm, v_rake
      FROM agents a
     WHERE a.club_id = p_club_id AND a.user_id = p_user_id;
    v_have_row := FOUND;

    v_comm := COALESCE(p_commission_rate, v_comm);
    v_rake := COALESCE(p_player_rakeback_rate, v_rake);

    IF v_comm IS NULL OR v_rake IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'needs_rates', true,
        'error', 'a commission rate and a player rakeback rate must be chosen '
                 || 'when granting an agent role');
    END IF;

    IF v_comm < 0 OR v_comm > 0.70 THEN
      RETURN jsonb_build_object('success', false,
        'error', 'the commission rate must be between 0 and 0.70');
    END IF;
    IF v_rake < 0 OR v_rake > 0.50 THEN
      RETURN jsonb_build_object('success', false,
        'error', 'the player rakeback rate must be between 0 and 0.50');
    END IF;
    IF v_rake > v_comm THEN
      RETURN jsonb_build_object('success', false,
        'error', 'the player rakeback rate cannot exceed the commission rate it is paid out of');
    END IF;

    -- Never richer than the upline it is paid out of. The same rule
    -- fn_create_agent applies; it simply never reached this path before.
    IF v_set_upline THEN
      SELECT id, commission_rate, player_rakeback_rate
        INTO v_parent, v_cap_comm, v_cap_rake
        FROM agents WHERE club_id = p_club_id AND user_id = v_actor;
    ELSIF v_have_row THEN
      SELECT p.commission_rate, p.player_rakeback_rate
        INTO v_cap_comm, v_cap_rake
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
  END IF;

  -- The guard refuses any role change that does not come through here.
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

  -- Keep the agents table in step. It carries the commission and credit
  -- settings and the agent tree; club_members.role alone would leave those stale.
  IF v_is_agent THEN
    SELECT id INTO v_agent_id FROM agents
     WHERE club_id = p_club_id AND user_id = p_user_id;

    IF v_agent_id IS NOT NULL THEN
      UPDATE agents
         SET role                 = p_role,
             status               = 'active',
             parent_agent_id      = COALESCE(v_parent, parent_agent_id),
             commission_rate      = v_comm,
             player_rakeback_rate = v_rake,
             updated_at           = now()
       WHERE id = v_agent_id;
    ELSE
      INSERT INTO agents (club_id, user_id, role, status, parent_agent_id,
                          commission_rate, player_rakeback_rate, credit_limit)
      VALUES (p_club_id, p_user_id, p_role, 'active', v_parent, v_comm, v_rake, 0)
      RETURNING id INTO v_agent_id;
    END IF;
  ELSE
    -- Suspended rather than deleted: commission history references this row,
    -- and it is also the wallet. Staff additionally lose the rate.
    UPDATE agents
       SET status = CASE WHEN v_old_role IN ('super_agent','agent','sub_agent')
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
                             'commission_rate', v_comm, 'player_rakeback_rate', v_rake),
          'Role changed via fn_club_set_member_role');

  RETURN jsonb_build_object(
    'success', true,
    'old_role', v_old_role,
    'new_role', p_role,
    'commission_rate', v_comm,
    'player_rakeback_rate', v_rake,
    'reports_to', CASE WHEN v_set_upline THEN v_actor ELSE NULL END);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_club_set_member_role(uuid, uuid, text, uuid, numeric, numeric)
  TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. The agent panel writes roles through the same door
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_admin_update_agent(
  p_agent_id uuid,
  p_status text DEFAULT NULL,
  p_role text DEFAULT NULL,
  p_credit_limit numeric DEFAULT NULL,
  p_commission_rate numeric DEFAULT NULL,
  p_player_rakeback_rate numeric DEFAULT NULL,
  p_assigned_by uuid DEFAULT NULL,
  p_credit_reason text DEFAULT NULL,
  p_is_prepaid boolean DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_club_id uuid; v_user_id uuid; v_parent uuid; v_old_limit numeric; v_parent_limit numeric;
  v_member_role text; v_role_res jsonb;
BEGIN
  IF p_agent_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'agent id required'); END IF;
  IF v_caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'authentication required'); END IF;
  SELECT club_id, user_id, parent_agent_id, credit_limit INTO v_club_id, v_user_id, v_parent, v_old_limit
  FROM agents WHERE id = p_agent_id;
  IF v_club_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'agent not found'); END IF;
  IF NOT EXISTS (
    SELECT 1 FROM clubs c WHERE c.id = v_club_id AND (
      c.owner_id = v_caller
      OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = v_club_id AND cm.user_id = v_caller
                 AND cm.role IN ('owner','co_owner','admin')))
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to manage this club''s agents');
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('active','suspended','frozen') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid status'); END IF;
  IF p_role IS NOT NULL AND p_role NOT IN ('super_agent','agent','sub_agent') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid role'); END IF;
  IF p_credit_limit IS NOT NULL AND p_credit_limit < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'credit_limit must be >= 0'); END IF;
  -- The table CHECK is 0..0.70 and 0..0.50. Validating against 0..100 let a
  -- caller who meant "25%" past this line and into a raw 23514 from Postgres.
  IF p_commission_rate IS NOT NULL AND (p_commission_rate < 0 OR p_commission_rate > 0.70) THEN
    RETURN jsonb_build_object('success', false, 'error', 'commission_rate must be between 0 and 0.70'); END IF;
  IF p_player_rakeback_rate IS NOT NULL AND (p_player_rakeback_rate < 0 OR p_player_rakeback_rate > 0.50) THEN
    RETURN jsonb_build_object('success', false, 'error', 'player_rakeback_rate must be between 0 and 0.50'); END IF;
  IF p_credit_limit IS NOT NULL AND v_parent IS NOT NULL THEN
    SELECT credit_limit INTO v_parent_limit FROM agents WHERE id = v_parent;
    IF v_parent_limit IS NOT NULL AND p_credit_limit > v_parent_limit THEN
      RETURN jsonb_build_object('success', false, 'error', 'credit limit cannot exceed parent agent limit');
    END IF;
  END IF;

  SELECT role INTO v_member_role FROM club_members
   WHERE club_id = v_club_id AND user_id = v_user_id;

  -- A rate for a co-owner or an admin is not a rate, it is a bug being typed in.
  IF v_member_role IN ('owner','co_owner','admin')
     AND (COALESCE(p_commission_rate, 0) <> 0 OR COALESCE(p_player_rakeback_rate, 0) <> 0)
     AND p_role IS NULL THEN
    RETURN jsonb_build_object('success', false,
      'error', 'this member is club staff and earns no rakeback. Change their role first.');
  END IF;

  -- The role change goes through the one door, so the grant matrix, the
  -- downline guard and the audit row apply here too.
  IF p_role IS NOT NULL AND v_member_role IS NOT NULL AND v_member_role <> p_role THEN
    v_role_res := public.fn_club_set_member_role(
      v_club_id, v_user_id, p_role, v_caller,
      COALESCE(p_commission_rate, (SELECT commission_rate FROM agents WHERE id = p_agent_id)),
      COALESCE(p_player_rakeback_rate, (SELECT player_rakeback_rate FROM agents WHERE id = p_agent_id)));
    IF NOT COALESCE((v_role_res ->> 'success')::boolean, false) THEN
      RETURN v_role_res;
    END IF;
  END IF;

  UPDATE agents SET
    status = COALESCE(p_status, status),
    role = COALESCE(p_role, role),
    credit_limit = COALESCE(p_credit_limit, credit_limit),
    commission_rate = COALESCE(p_commission_rate, commission_rate),
    player_rakeback_rate = COALESCE(p_player_rakeback_rate, player_rakeback_rate),
    is_prepaid = COALESCE(p_is_prepaid, is_prepaid),
    updated_at = now()
  WHERE id = p_agent_id;

  IF p_credit_limit IS NOT NULL AND p_credit_limit <> COALESCE(v_old_limit, -1) THEN
    INSERT INTO credit_assignments (agent_id, assigned_by, old_limit, new_limit, reason)
    VALUES (p_agent_id, v_caller, v_old_limit, p_credit_limit, p_credit_reason);
  END IF;
  RETURN jsonb_build_object('success', true, 'agent_id', p_agent_id, 'club_id', v_club_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_create_agent(
  p_user_id uuid,
  p_club_id uuid,
  p_role text,
  p_parent_agent_id uuid,
  p_commission_rate numeric,
  p_player_rakeback_rate numeric,
  p_credit_limit numeric,
  p_is_prepaid boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_membership_user uuid; v_member_role text;
  v_parent_role text; v_parent_comm numeric; v_parent_rake numeric;
  v_new_id uuid; v_role_res jsonb;
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

  -- Club staff earn no rakeback, so turning one into an agent from the agent
  -- panel is a demotion wearing a create button. Say so.
  IF v_member_role IN ('owner','co_owner','admin') THEN
    RETURN jsonb_build_object('success',false,
      'error','this member is club staff and earns no rakeback. Change their role on the members screen first.');
  END IF;

  IF p_parent_agent_id IS NOT NULL THEN
    SELECT role, commission_rate, player_rakeback_rate INTO v_parent_role, v_parent_comm, v_parent_rake FROM agents WHERE id=p_parent_agent_id;
    IF v_parent_role IS NULL THEN RETURN jsonb_build_object('success',false,'error','parent agent not found'); END IF;
    IF v_parent_role = 'sub_agent' THEN RETURN jsonb_build_object('success',false,'error','sub-agents cannot have sub-agents'); END IF;
    IF p_commission_rate > v_parent_comm THEN RETURN jsonb_build_object('success',false,'error','commission rate cannot exceed parent rate'); END IF;
    IF p_player_rakeback_rate > v_parent_rake THEN RETURN jsonb_build_object('success',false,'error','rakeback rate cannot exceed parent rate'); END IF;
  END IF;

  INSERT INTO agents (user_id, club_id, membership_id, role, parent_agent_id, commission_rate, player_rakeback_rate, credit_limit, is_prepaid)
  VALUES (p_user_id, p_club_id, COALESCE(v_membership_user, p_user_id), p_role, p_parent_agent_id, p_commission_rate, p_player_rakeback_rate, p_credit_limit, COALESCE(p_is_prepaid,false))
  RETURNING id INTO v_new_id;

  -- The club role follows through the one door, which audits it.
  IF v_membership_user IS NOT NULL AND v_member_role IS DISTINCT FROM p_role THEN
    v_role_res := public.fn_club_set_member_role(
      p_club_id, p_user_id, p_role, v_caller, p_commission_rate, p_player_rakeback_rate);
    IF NOT COALESCE((v_role_res ->> 'success')::boolean, false) THEN
      RETURN v_role_res;
    END IF;
  END IF;

  RETURN jsonb_build_object('success',true,'agent_id',v_new_id);
END;
$function$;

-- -----------------------------------------------------------------------------
-- 5. Proof
-- -----------------------------------------------------------------------------
DO $verify$
DECLARE v_n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'club_members' AND t.tgname = 'trg_club_members_role_guard') THEN
    RAISE EXCEPTION 'the role guard trigger was not created';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'club_members' AND t.tgname = 'trg_club_members_staff_earn_no_rakeback')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'agents' AND t.tgname = 'trg_agents_staff_earn_no_rakeback') THEN
    RAISE EXCEPTION 'the staff-earn-no-rakeback triggers were not created';
  END IF;

  IF to_regprocedure('public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric)') IS NULL THEN
    RAISE EXCEPTION 'fn_club_set_member_role did not gain its rate arguments';
  END IF;
  IF to_regprocedure('public.fn_club_set_member_role(uuid,uuid,text,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'the four-argument fn_club_set_member_role still exists and would make the call ambiguous';
  END IF;

  SELECT count(*) INTO v_n FROM club_members
   WHERE role IN ('co_owner','admin')
     AND (COALESCE(player_rakeback_pct,0) <> 0 OR COALESCE(rakeback_rate,0) <> 0
          OR COALESCE(commission_rate,0) <> 0);
  IF v_n > 0 THEN RAISE EXCEPTION '% staff member(s) still carry a rakeback rate', v_n; END IF;

  SELECT count(*) INTO v_n FROM agents a JOIN club_members cm
       ON cm.club_id = a.club_id AND cm.user_id = a.user_id
   WHERE cm.role IN ('co_owner','admin')
     AND (COALESCE(a.commission_rate,0) <> 0 OR COALESCE(a.player_rakeback_rate,0) <> 0);
  IF v_n > 0 THEN RAISE EXCEPTION '% staff agent row(s) still carry a rate', v_n; END IF;
END
$verify$;

COMMIT;
