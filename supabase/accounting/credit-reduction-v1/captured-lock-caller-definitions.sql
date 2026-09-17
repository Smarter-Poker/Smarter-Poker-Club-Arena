-- RETAINED METADATA DEFINITIONS ONLY. Not an activation loader or proposed replacement.

-- fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric,boolean,numeric); observed ACL ['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']
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

  -- PHASE 7. What the club still owes this person, from the ledger the claim
  -- path settles - rather than from the agents column that migration drops,
  -- which nothing ever wrote. It said 26,859.87 across 5 agents on a day the
  -- ledger held 408,809.59 across 114, so 109 of those 114 were reported to the
  -- person changing their role as owed nothing at all. One partial-index lookup
  -- (agent_commissions_unsettled_idx).
  -- reads the ledger directly: this function has already authorized its
  -- actor through fn_club_grantable_roles above, and it is SECURITY DEFINER,
  -- so it does not need the guarded caller-facing RPC's door. That RPC now
  -- admits only self, club admin and above, an agent ancestor, or the
  -- service role, and THIS report must not be able to fail on it. Same
  -- SELECT, same partial index (agent_commissions_unsettled_idx).
  SELECT COALESCE(SUM(ac.amount), 0)::numeric INTO v_commission
    FROM public.agent_commissions ac
   WHERE ac.club_id = p_club_id
     AND ac.user_id = p_user_id
     AND ac.settled_at IS NULL AND NOT public.fn_agent_commission_paid_by_period(ac.club_id, ac.user_id, ac.created_at);

  -- v_old_role was checked against the three AGENT tiers here, which missed the
  -- people phase 2 deliberately gave wallets to. A co-owner or an admin holds an
  -- agent wallet by design - Dan: "OWNERS AND CO OWNERS CAN AND SHOULD HAVE
  -- AGENT WALLETS" - so demoting one straight to player took the wallet away
  -- with the float still in it, which is the exact defect this phase exists to
  -- stop. Any role that is not already 'player' can be holding one.
  IF NOT v_keeps_wallet AND v_old_role <> 'player' THEN
    SELECT COALESCE(a.agent_wallet_balance, 0), COALESCE(a.credit_used, 0)
      INTO v_float, v_owed
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
        'unclaimed_commission', COALESCE(v_commission, 0));
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
    'unclaimed_commission', COALESCE(v_commission, 0),
    'reports_to', CASE WHEN v_set_upline THEN v_actor ELSE NULL END);
END;
$function$
;

-- fn_assign_agent_to_super_agent(uuid,uuid,uuid); observed ACL ['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']
CREATE OR REPLACE FUNCTION public.fn_assign_agent_to_super_agent(p_agent_user_id uuid, p_super_agent_user_id uuid, p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_agent uuid; v_super uuid;
BEGIN
  IF NOT public.fn_is_any_union_overseer(auth.uid()) AND NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  SELECT id INTO v_agent FROM agents WHERE user_id = p_agent_user_id AND club_id = p_club_id;
  SELECT id INTO v_super FROM agents WHERE user_id = p_super_agent_user_id AND club_id = p_club_id;
  IF v_agent IS NULL OR v_super IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent_or_super_agent_not_found');
  END IF;
  IF v_agent = v_super THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent_cannot_report_to_itself');
  END IF;
  -- No cycles: the proposed parent must not already sit beneath this agent.
  IF EXISTS (
    WITH RECURSIVE up AS (
      SELECT id, parent_agent_id FROM agents WHERE id = v_super
      UNION ALL
      SELECT a.id, a.parent_agent_id FROM agents a JOIN up ON up.parent_agent_id = a.id
    ) SELECT 1 FROM up WHERE id = v_agent
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'would_create_cycle');
  END IF;

  UPDATE agents SET parent_agent_id = v_super, updated_at = now() WHERE id = v_agent;
  UPDATE agents SET role = 'super_agent', updated_at = now()
   WHERE id = v_super AND COALESCE(role,'agent') <> 'super_agent';

  RETURN jsonb_build_object('success', true, 'agent_id', v_agent, 'super_agent_id', v_super);
END $function$
;

-- fn_ensure_agent_row(uuid,uuid,text); observed ACL ['postgres=X/postgres', 'service_role=X/postgres']
CREATE OR REPLACE FUNCTION public.fn_ensure_agent_row(p_club_id uuid, p_user_id uuid, p_role text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id    uuid;
  v_union uuid;
  v_min   numeric;
  v_role  text;
  v_staff boolean;
begin
  select a.id into v_id
    from agents a
   where a.club_id = p_club_id and a.user_id = p_user_id
   for update;
  if v_id is not null then
    return v_id;
  end if;

  -- agents.role CHECK still admits only the three agent tiers, so a staff
  -- wallet holder is stored as 'super_agent'. The data lies about who holds the
  -- wallet; club_members.role is the truth and every rule reads it. Recorded as
  -- P3 debt for phase 7, not fixed here, because relaxing that CHECK is a table
  -- lock on agents and this migration deliberately takes none.
  v_role := case when p_role in ('super_agent', 'agent', 'sub_agent') then p_role
                 else 'super_agent' end;

  v_staff := exists (
    select 1 from club_members cm
     where cm.club_id = p_club_id and cm.user_id = p_user_id
       and cm.role in ('co_owner', 'admin'));

  select coalesce(uc.union_id, c.union_id) into v_union
    from clubs c
    left join union_clubs uc on uc.club_id = c.id
   where c.id = p_club_id
   limit 1;

  -- A rate nobody chose is the bug phase 0 removed from the promotion path.
  -- Staff earn nothing by law, so minting them at the union minimum invented a
  -- commission AND tripped the band on the way back down to zero.
  v_min := case when v_staff then 0
                when v_union is null then 0
                else public.fn_union_setting(v_union, 'min_agent_commission', 0) end;

  -- Prepaid with no line: a wallet that appears because somebody was sent chips
  -- must not also arrive able to borrow. A credit line is granted deliberately,
  -- through the promotion screen or the agent panel, never as a side effect.
  insert into agents (user_id, club_id, role, status,
                      agent_wallet_balance, promo_wallet_balance,
                      commission_rate, player_rakeback_rate,
                      credit_limit, credit_used, is_prepaid)
  values (p_user_id, p_club_id, v_role, 'active', 0, 0, v_min, 0, 0, 0, true)
  on conflict (user_id, club_id) do nothing;

  select a.id into v_id
    from agents a
   where a.club_id = p_club_id and a.user_id = p_user_id
   for update;
  return v_id;
end
$function$
;

-- fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid); observed ACL ['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_send(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then
    return jsonb_build_object('success',false,'error','Not Authenticated');
  end if;
  if p_op_id is null then
    return jsonb_build_object('success',false,'error','A Retry Key Is Required For Every Send');
  end if;
  return public.fn_agent_wallet_send_phase2_core_20260831(
    p_club_id,p_to_user_id,p_amount,p_destination,p_reason,p_op_id
  );
end
$function$
;

-- fn_agent_wallet_send_phase2_core_20260831(uuid,uuid,numeric,text,text,uuid); observed ACL ['postgres=X/postgres', 'service_role=X/postgres']
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_send_phase2_core_20260831(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_op_id uuid := coalesce(p_op_id,gen_random_uuid());
  v_destination text := lower(coalesce(p_destination,'player_wallet'));
  v_prior record;
  v_replay_destination text;
  v_actor_role text;
  v_target_role text;
  v_first uuid;
  v_second uuid;
begin
  if v_actor is null then return jsonb_build_object('success',false,'error','Not Authenticated'); end if;
  if p_club_id is null or p_to_user_id is null or p_to_user_id=v_actor then
    return jsonb_build_object('success',false,'error','Choose Another Active Member');
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1e9 or p_amount<>round(p_amount,2) then
    return jsonb_build_object('success',false,'error','Enter A Valid Send Amount');
  end if;
  if v_destination not in ('player_wallet','agent_wallet') then
    return jsonb_build_object('success',false,'error','Unknown Destination Wallet');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'agent-wallet-send:'||p_club_id::text||':'||v_actor::text||':'||v_op_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||p_club_id::text,0));

  select ct.* into v_prior from public.chip_transactions ct
   where ct.club_id=p_club_id and ct.transaction_type='agent_wallet_send'
     and ct.from_user_id=v_actor and ct.metadata->>'op_id'=v_op_id::text limit 1;
  if found then
    v_replay_destination := case
      when coalesce(v_prior.metadata->>'recipient_role','') in
        ('owner','co_owner','admin','super_agent','agent','sub_agent')
      then 'agent_wallet' else v_destination end;
    if v_prior.to_user_id is distinct from p_to_user_id
       or v_prior.amount is distinct from p_amount
       or coalesce(v_prior.metadata->>'destination','') is distinct from v_replay_destination then
      return jsonb_build_object('success',false,
        'error','That Retry Key Belongs To A Different Agent Wallet Send');
    end if;
    return jsonb_build_object(
      'success',true,'replayed',true,'transaction_id',v_prior.id,'amount',v_prior.amount,
      'destination',v_prior.metadata->>'destination',
      'agent_wallet_after',(v_prior.metadata->>'agent_wallet_after')::numeric,
      'recipient_balance_after',(v_prior.metadata->>'recipient_balance_after')::numeric,
      'credit_drawn',coalesce((v_prior.metadata->>'credit_drawn')::numeric,0),
      'credit_used_after',(v_prior.metadata->>'credit_used_after')::numeric,
      'credit_limit',(v_prior.metadata->>'credit_limit')::numeric);
  end if;

  -- Ownership and both membership rows stay locked through the core operation.
  -- A concurrent role revocation, downline reassignment, or member deletion
  -- must complete before or after this send, never between its checks and debit.
  perform 1 from public.clubs where id=p_club_id for update;
  if not found then return jsonb_build_object('success',false,'error','That Club Could Not Be Found'); end if;
  if v_actor<p_to_user_id then v_first:=v_actor; v_second:=p_to_user_id;
  else v_first:=p_to_user_id; v_second:=v_actor; end if;
  perform 1 from public.club_members where club_id=p_club_id and user_id=v_first for update;
  perform 1 from public.club_members where club_id=p_club_id and user_id=v_second for update;

  v_actor_role:=public.fn_club_bank_role(p_club_id,v_actor);
  select role into v_target_role from public.club_members
   where club_id=p_club_id and user_id=p_to_user_id
     and coalesce(status,'active') in ('active','approved');
  if v_actor_role is null
     or v_actor_role not in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    return jsonb_build_object('success',false,'error','Your Cashier Authority Is No Longer Active');
  end if;
  if v_target_role is null then
    return jsonb_build_object('success',false,'error','Recipient Is Not An Active Member Of This Club');
  end if;
  if not public.fn_club_cashier_can_transact(p_club_id,v_actor,p_to_user_id) then
    return jsonb_build_object('success',false,'error','That Member Is Not In Your Downline');
  end if;

  -- Agent recipients always receive agent float; bind the replay fingerprint
  -- to the effective destination, not a caller-controlled label.
  if v_target_role in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    v_destination:='agent_wallet';
  end if;

  return public.fn_agent_wallet_send_core_20260830(
    p_club_id,p_to_user_id,p_amount,v_destination,p_reason,v_op_id);
end
$function$
;

-- fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid); observed ACL ['postgres=X/postgres', 'service_role=X/postgres']
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_send_core_20260830(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_context jsonb;
  v_setting text;
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dest         text := lower(coalesce(p_destination, 'player_wallet'));
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_agent_id     uuid;
  v_float_before numeric;
  v_float_after  numeric;
  v_is_prepaid   boolean;
  v_credit_limit numeric;
  v_credit_used  numeric;
  v_credit_after numeric;
  v_shortfall    numeric := 0;
  v_headroom     numeric;
  v_to_role      text;
  v_to_agent_id  uuid;
  v_to_after     numeric;
  v_tx_id        uuid;
  v_until        timestamptz;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'agent_wallet_send'
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric,
      'credit_drawn', coalesce((v_prior.metadata ->> 'credit_drawn')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric,
      'credit_limit', (v_prior.metadata ->> 'credit_limit')::numeric);
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null
     or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false,
      'error', 'Chips Move In Hundredths At Most');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Send Limit');
  end if;
  if v_dest not in ('player_wallet', 'agent_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Destination Wallet');
  end if;
  if p_to_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recipient');
  end if;
  if p_to_user_id = v_actor then
    return jsonb_build_object('success', false,
      'error', 'You Cannot Send Chips To Yourself');
  end if;

  if not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object('success', false,
      'error', 'That Member Is Not In Your Downline');
  end if;

  select cm.role into v_to_role
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = p_to_user_id
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_to_role is null then
    return jsonb_build_object('success', false,
      'error', 'Recipient Is Not An Active Member Of This Club');
  end if;
  if v_dest = 'agent_wallet'
     and v_to_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;

  if v_to_role in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    v_dest := 'agent_wallet';
  end if;

  select a.id, coalesce(a.agent_wallet_balance, 0),
         coalesce(a.is_prepaid, true),
         coalesce(a.credit_limit, 0), coalesce(a.credit_used, 0)
    into v_agent_id, v_float_before, v_is_prepaid, v_credit_limit, v_credit_used
    from agents a
   where a.club_id = p_club_id and a.user_id = v_actor
   for update;
  if v_agent_id is null then
    return jsonb_build_object('success', false,
      'error', 'Your Agent Wallet Has Not Been Funded Yet');
  end if;

  -- THE CREDIT LINE. Dan, 2026-08-31: "IF THEY GO BELOW THE CREDIT LIMIT, THEY
  -- MUST 'SQUARE UP' OR PRE PAY FOR CHIPS FOR THE REST OF THE WEEK." So the
  -- limit caps the debt outstanding, not the amount ever borrowed: an agent
  -- draws credit_limit - credit_used, and paying an invoice frees it again
  -- (fn_apply_credit_payment pays credit_used down, phase 1).
  if v_float_before < p_amount then
    v_shortfall := round(p_amount - v_float_before, 2);

    -- A prepaid agent, and an agent with no line at all, get the plain answer
    -- about their wallet. Talking about a credit line to somebody who has none
    -- is the sort of message that sends a person looking for a setting.
    if v_is_prepaid or v_credit_limit <= 0 then
      return jsonb_build_object('success', false,
        'error', 'Your Agent Wallet Only Holds '
                 || trim(to_char(v_float_before, 'FM999,999,999,990.00')) || ' Chips',
        'balance', v_float_before, 'requested', p_amount,
        'prepaid', v_is_prepaid);
    end if;

    v_headroom := v_credit_limit - v_credit_used;
    if v_shortfall > v_headroom then
      return jsonb_build_object('success', false,
        'error', 'Your Wallet Holds '
                 || trim(to_char(v_float_before, 'FM999,999,999,990.00'))
                 || ' Chips And Your Credit Line Has '
                 || trim(to_char(greatest(v_headroom, 0), 'FM999,999,999,990.00'))
                 || ' Left. Square Up Your Invoice Or Add Chips To Send This Much.',
        'balance', v_float_before, 'requested', p_amount,
        'credit_limit', v_credit_limit, 'credit_used', v_credit_used,
        'credit_available', greatest(v_headroom, 0),
        'shortfall', v_shortfall);
    end if;
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): an agent wallet send is ONE `agent_send`
  -- row from the sender's float to the wallet that receives it, keyed and
  -- correlated on the op. Verified on 2026-09-01 14:23:18 (10,000.00 to a
  -- player) the undeclared journal was `adjustment agent_wallet ->
  -- settlement_suspense` plus `adjustment table_stack -> player_wallet`. The
  -- agents trigger is skipped for both float writes: a player recipient's
  -- club_members trigger writes the row with the sender's float as its
  -- counterparty; an agent recipient (both sides in `agents`) gets the row
  -- posted explicitly below. When the credit line covers a shortfall the
  -- float only pays p_amount - v_shortfall, so the draw is its own
  -- `credit_draw credit_facility -> agent_wallet` row for the difference and
  -- the send row still carries the whole amount. Never a refusal.
  select jsonb_object_agg(k,coalesce(current_setting(k,true),'')) into v_context
   from unnest(array['app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_tournament','app.ledger_settlement','app.ledger_idempotency_key','app.ledger_correlation','app.ledger_autoskip_agents']) settings(k);
  perform set_config('app.ledger_tournament','',true);
  perform set_config('app.ledger_settlement','',true);
  perform public.fn_ca_declare_ledger('agent_send', 'agent_wallet', v_actor, null,
    'agent_send:' || v_op_id::text, array['agents']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);
  if v_shortfall > 0 then
    perform public.fn_ca_post_leg('credit_draw', 'credit_facility', v_actor, 'agent_wallet', v_actor,
      v_shortfall, p_club_id, 'agent_send:credit:' || v_op_id::text,
      'Agent credit line covers the shortfall of an agent wallet send (fn_agent_wallet_send_core_20260830)');
  end if;

  -- The wallet pays what it can and the line covers the rest, so the balance
  -- lands on exactly zero rather than going negative.
  update agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - (p_amount - v_shortfall),
         credit_used          = coalesce(credit_used, 0) + v_shortfall,
         updated_at = now()
   where id = v_agent_id
   returning agent_wallet_balance, credit_used into v_float_after, v_credit_after;

  if v_dest = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;
  else
    v_to_agent_id := public.fn_ensure_agent_row(p_club_id, p_to_user_id, v_to_role);
    if v_to_agent_id is null then
      raise exception 'could not ensure agents row for % in club %', p_to_user_id, p_club_id;
    end if;
    update agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount,
           updated_at = now()
     where id = v_to_agent_id
     returning agent_wallet_balance into v_to_after;
    perform set_config('app.ledger_idempotency_key', '', true);
    perform public.fn_ca_post_leg('agent_send', 'agent_wallet', v_actor, 'agent_wallet', p_to_user_id,
      p_amount, p_club_id, 'agent_send:' || v_op_id::text,
      'Agent wallet send to a downline agent wallet (fn_agent_wallet_send_core_20260830)');
  end if;

  for v_setting in select jsonb_object_keys(v_context) loop
    perform set_config(v_setting,v_context->>v_setting,true);
  end loop;

  v_until := now() + interval '10 minutes';

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata,
     balance_after, reversible_until)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'agent_wallet_send',
     coalesce(nullif(btrim(p_reason), ''), 'Agent Wallet Send'),
     jsonb_build_object(
       'op_id', v_op_id,
       'destination', v_dest,
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'agent_wallet_before', v_float_before,
       'agent_wallet_after', v_float_after,
       'recipient_balance_after', v_to_after,
       'claimed_back', 0,
       -- What was borrowed to make this send, and how much of that borrowing
       -- has since been handed back. The claim back reads both.
       'credit_drawn', v_shortfall,
       'credit_repaid', 0,
       'credit_used_after', v_credit_after,
       'credit_limit', v_credit_limit,
       'clawback_window_minutes', 10),
     v_float_after, v_until)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'destination', v_dest,
    'agent_wallet_before', v_float_before,
    'agent_wallet_after', v_float_after,
    'recipient_balance_after', v_to_after,
    'credit_drawn', v_shortfall,
    'credit_used_after', v_credit_after,
    'credit_limit', v_credit_limit,
    'reversible_until', v_until);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'agent_wallet_send'
       and from_user_id = v_actor
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    if v_prior.id is null then
      raise;
    end if;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric,
      'credit_drawn', coalesce((v_prior.metadata ->> 'credit_drawn')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric,
      'credit_limit', (v_prior.metadata ->> 'credit_limit')::numeric);
end
$function$
;

-- fn_agent_wallet_claim_back(uuid,uuid,numeric,text,uuid); observed ACL ['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_claim_back(p_club_id uuid, p_transaction_id uuid, p_amount numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then
    return jsonb_build_object('success',false,'error','Not Authenticated');
  end if;
  if p_op_id is null then
    return jsonb_build_object('success',false,'error','A Retry Key Is Required For Every Claim Back');
  end if;
  return public.fn_agent_wallet_claim_back_phase2_core_20260831(
    p_club_id,p_transaction_id,p_amount,p_reason,p_op_id
  );
end
$function$
;

-- fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid); observed ACL ['postgres=X/postgres', 'service_role=X/postgres']
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_claim_back_phase2_core_20260831(p_club_id uuid, p_transaction_id uuid, p_amount numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_context jsonb;
  v_setting text;
  v_actor            uuid := auth.uid();
  v_op_id            uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior            record;
  v_src              record;
  v_claimed          numeric;
  v_claimed_after    numeric;
  v_remaining_exact  numeric;
  v_remaining        numeric;
  v_take             numeric;
  v_complete         boolean;
  v_dest             text;
  v_held             numeric;
  v_agent_id         uuid;
  v_float_after      numeric;
  v_holder_after     numeric;
  v_tx_id            uuid;
  v_drawn            numeric;
  v_repaid           numeric;
  v_repay            numeric := 0;
  v_my_agent_id      uuid;
  v_my_used          numeric;
  v_credit_after     numeric;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;
  if p_club_id is null or p_transaction_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recent Agent Wallet Send');
  end if;
  if p_amount is not null and
     (p_amount <= 0 or p_amount > 1e9 or p_amount <> round(p_amount, 2)) then
    return jsonb_build_object(
      'success', false,
      'error', 'Claim Back Amounts Must Be Positive Whole Cents');
  end if;

  -- One caller/op pair is serialized, so two simultaneous retries cannot both
  -- pass the replay read and enter the money section.
  perform pg_advisory_xact_lock(hashtextextended(
    'agent-wallet-claim:' || p_club_id::text || ':' || v_actor::text || ':' || v_op_id::text,
    0
  ));

  select id, amount, metadata into v_prior
    from public.chip_transactions
   where club_id = p_club_id
     and transaction_type = 'agent_wallet_claim_back'
     and to_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    if coalesce(v_prior.metadata ->> 'original_transaction_id', '')
         is distinct from p_transaction_id::text
       or (p_amount is not null and v_prior.amount is distinct from p_amount) then
      return jsonb_build_object(
        'success', false,
        'error', 'That Retry Key Belongs To A Different Claim Back');
    end if;
    return jsonb_build_object(
      'success', true,
      'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'credit_repaid', coalesce((v_prior.metadata ->> 'credit_repaid')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric);
  end if;

  select * into v_src
    from public.chip_transactions
   where id = p_transaction_id
     and club_id = p_club_id
   for update;
  if v_src is null then
    return jsonb_build_object('success', false, 'error', 'That Send Could Not Be Found');
  end if;
  if v_src.transaction_type <> 'agent_wallet_send' then
    return jsonb_build_object(
      'success', false,
      'error', 'Only An Agent Wallet Send Can Be Claimed Back This Way');
  end if;
  if v_src.from_user_id is distinct from v_actor then
    return jsonb_build_object(
      'success', false,
      'error', 'You Can Only Claim Back Chips You Sent Yourself');
  end if;
  if coalesce(v_src.is_reversed, false) then
    return jsonb_build_object('success', false, 'error', 'That Send Has Already Been Claimed Back');
  end if;
  if v_src.reversible_until is null or now() > v_src.reversible_until then
    return jsonb_build_object(
      'success', false,
      'error', 'The Ten Minute Window To Claim These Chips Back Has Closed. '
               || 'The Player Must Request A Cash Out Instead');
  end if;

  v_claimed := coalesce((v_src.metadata ->> 'claimed_back')::numeric, 0);
  v_remaining_exact := greatest(v_src.amount - v_claimed, 0);

  -- Round DOWN, never to nearest. A historical 9.9951 remainder can safely
  -- return 9.99; rounding it to 10.00 would create another 0.0049 chips.
  v_remaining := trunc(v_remaining_exact, 2);
  if v_remaining < 0.01 then
    return jsonb_build_object('success', false, 'error', 'That Send Has Already Been Claimed Back');
  end if;

  -- Null means all safely claimable whole cents. This is what the cashier uses
  -- so contaminated historical rows can be closed without echoing sub-cents.
  v_take := coalesce(p_amount, v_remaining);
  if v_take > v_remaining then
    return jsonb_build_object(
      'success', false,
      'error', 'Only ' || trim(to_char(v_remaining, 'FM999,999,999,990.00'))
               || ' Chips Of That Send Are Left To Claim Back',
      'remaining', v_remaining,
      'requested', v_take);
  end if;

  v_claimed_after := v_claimed + v_take;
  v_complete := (v_src.amount - v_claimed_after) < 0.01;

  v_dest := coalesce(v_src.metadata ->> 'destination', 'player_wallet');
  if v_dest = 'player_wallet' then
    select coalesce(chip_balance, 0) into v_held
      from public.club_members
     where club_id = p_club_id and user_id = v_src.to_user_id
     for update;
  else
    select a.id, coalesce(a.agent_wallet_balance, 0) into v_agent_id, v_held
      from public.agents a
     where a.club_id = p_club_id and a.user_id = v_src.to_user_id
     for update;
  end if;

  if v_held is null then
    return jsonb_build_object(
      'success', false,
      'error', 'That Wallet Could Not Be Read, So Nothing Was Moved');
  end if;
  if v_held < v_take then
    return jsonb_build_object(
      'success', false,
      'error', 'Those Chips Have Already Been Spent. That Wallet Only Holds '
               || trim(to_char(v_held, 'FM999,999,999,990.00')) || ' Chips',
      'held', v_held,
      'requested', v_take);
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): a claim back is ONE `agent_claim` row from
  -- the wallet that held the send back to the agent's float, keyed and
  -- correlated on the op. The agents trigger is skipped for both float
  -- writes: a player holder's club_members trigger writes the row with the
  -- agent's float as counterparty; an agent holder (both sides in `agents`)
  -- gets the row posted explicitly below. The share that repays the credit
  -- line never reaches the float, so it is its own `credit_repayment
  -- agent_wallet -> credit_facility` row. Never a refusal.
  select jsonb_object_agg(k,coalesce(current_setting(k,true),'')) into v_context
   from unnest(array['app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_tournament','app.ledger_settlement','app.ledger_idempotency_key','app.ledger_correlation','app.ledger_autoskip_agents']) settings(k);
  perform set_config('app.ledger_tournament','',true);
  perform set_config('app.ledger_settlement','',true);
  perform public.fn_ca_declare_ledger('agent_claim', 'agent_wallet', v_actor, null,
    'agent_claim:' || v_op_id::text, array['agents']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

  if v_dest = 'player_wallet' then
    update public.club_members
       set chip_balance = coalesce(chip_balance, 0) - v_take,
           updated_at = now()
     where club_id = p_club_id and user_id = v_src.to_user_id
     returning chip_balance into v_holder_after;
  else
    update public.agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - v_take,
           updated_at = now()
     where id = v_agent_id
     returning agent_wallet_balance into v_holder_after;
    perform set_config('app.ledger_idempotency_key', '', true);
    perform public.fn_ca_post_leg('agent_claim', 'agent_wallet', v_src.to_user_id, 'agent_wallet', v_actor,
      v_take, p_club_id, 'agent_claim:' || v_op_id::text,
      'Agent wallet claim back from a downline agent wallet (fn_agent_wallet_claim_back_phase2_core_20260831)');
  end if;

  -- HOW MUCH OF THIS CLAIM IS A REPAYMENT.
  --
  -- credit_drawn is what this send borrowed; credit_repaid is how much of that
  -- borrowing earlier partial claims have already handed back. The share of a
  -- partial claim is proportional, truncated down so repeated partials can
  -- never repay more than was drawn. The final claim settles the exact
  -- remainder, so truncation cannot strand a cent of debt on a send that has
  -- been returned in full.
  v_drawn  := coalesce((v_src.metadata ->> 'credit_drawn')::numeric, 0);
  v_repaid := coalesce((v_src.metadata ->> 'credit_repaid')::numeric, 0);

  select a.id, coalesce(a.credit_used, 0) into v_my_agent_id, v_my_used
    from public.agents a
   where a.club_id = p_club_id and a.user_id = v_actor
   for update;
  if v_my_agent_id is null then
    raise exception 'agent wallet row vanished for % in club %', v_actor, p_club_id;
  end if;

  if v_drawn > 0 then
    if v_complete then
      v_repay := greatest(v_drawn - v_repaid, 0);
    else
      v_repay := least(trunc(v_drawn * v_take / v_src.amount, 2),
                       greatest(v_drawn - v_repaid, 0));
    end if;
    -- The debt may already have been settled another way: an invoice paid
    -- inside the ten minute window pays credit_used down (phase 1), and paying
    -- twice for the same borrowing would hand the agent free chips.
    v_repay := greatest(least(v_repay, v_my_used), 0);
  end if;

  if v_repay > 0 then
    perform public.fn_ca_post_leg('credit_repayment', 'agent_wallet', v_actor, 'credit_facility', v_actor,
      v_repay, p_club_id, 'agent_claim:credit:' || v_op_id::text,
      'Claimed back chips repay the credit line drawn for the send (fn_agent_wallet_claim_back_phase2_core_20260831)');
  end if;

  -- Every chip returns: what is not repaying a debt becomes float.
  update public.agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + (v_take - v_repay),
         credit_used          = greatest(coalesce(credit_used, 0) - v_repay, 0),
         updated_at = now()
   where id = v_my_agent_id
   returning agent_wallet_balance, credit_used into v_float_after, v_credit_after;
  for v_setting in select jsonb_object_keys(v_context) loop
    perform set_config(v_setting,v_context->>v_setting,true);
  end loop;

  update public.chip_transactions
     set metadata = coalesce(metadata, '{}'::jsonb)
                    || jsonb_build_object('claimed_back', v_claimed_after,
                                          'credit_repaid', v_repaid + v_repay),
         is_reversed = v_complete,
         clawed_back = v_complete
   where id = v_src.id;

  insert into public.chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, v_src.to_user_id, v_actor, v_take, 'agent_wallet_claim_back',
     coalesce(nullif(btrim(p_reason), ''), 'Agent Wallet Claim Back Inside The Ten Minute Window'),
     jsonb_build_object(
       'op_id', v_op_id,
       'source', v_dest,
       'original_transaction_id', v_src.id,
       'holder_balance_after', v_holder_after,
       'agent_wallet_after', v_float_after,
       'credit_repaid', v_repay,
       'credit_used_after', v_credit_after),
     v_float_after)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true,
    'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', v_take,
    'source', v_dest,
    'holder_balance_after', v_holder_after,
    'agent_wallet_after', v_float_after,
    'credit_repaid', v_repay,
    'credit_used_after', v_credit_after);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from public.chip_transactions
     where club_id = p_club_id
       and transaction_type = 'agent_wallet_claim_back'
       and to_user_id = v_actor
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    if v_prior.id is null then
      raise;
    end if;
    if coalesce(v_prior.metadata ->> 'original_transaction_id', '')
         is distinct from p_transaction_id::text
       or (p_amount is not null and v_prior.amount is distinct from p_amount) then
      return jsonb_build_object(
        'success', false,
        'error', 'That Retry Key Belongs To A Different Claim Back');
    end if;
    return jsonb_build_object(
      'success', true,
      'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'credit_repaid', coalesce((v_prior.metadata ->> 'credit_repaid')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric);
end
$function$
;

-- fn_process_credit_invoice_payment(uuid,numeric,text,uuid,text); observed ACL ['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']
CREATE OR REPLACE FUNCTION public.fn_process_credit_invoice_payment(p_invoice_id uuid, p_amount numeric, p_method text, p_operation_id uuid, p_reference text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE inv public.credit_invoices%ROWTYPE; agent public.agents%ROWTYPE; pay public.credit_payments%ROWTYPE;
 actor uuid:=auth.uid(); engine boolean:=public.fn_caller_is_engine(); remaining numeric; old_club text; deducted boolean; new_status text;
BEGIN
 IF p_invoice_id IS NULL OR p_operation_id IS NULL OR p_amount IS NULL OR p_amount<=0
    OR p_amount::text IN('NaN','Infinity','-Infinity') OR p_amount<>round(p_amount,2)
 THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','invalid_payment'); END IF;
 IF p_method IS NULL OR p_method NOT IN('wallet','external') THEN
   RETURN jsonb_build_object('ok',false,'success',false,'reason','unsupported_payment_method'); END IF;
 SELECT * INTO inv FROM public.credit_invoices WHERE id=p_invoice_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','invoice_not_found'); END IF;
 SELECT * INTO agent FROM public.agents WHERE id=inv.agent_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','agent_user_not_found'); END IF;
 IF p_method='wallet' THEN
   -- A service credential is not authority to spend an arbitrary user's wallet.
   IF actor IS NULL OR actor<>agent.user_id THEN
    RAISE EXCEPTION 'not_your_wallet' USING ERRCODE='42501'; END IF;
 ELSE
   IF NOT engine AND (actor IS NULL OR NOT (public.fn_is_club_admin_uid(agent.club_id) OR public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'only_receiving_club_can_record_external_payment' USING ERRCODE='42501'; END IF;
   IF NULLIF(btrim(p_reference),'') IS NULL OR length(p_reference)>256 THEN
    RETURN jsonb_build_object('ok',false,'success',false,'reason','payment_reference_required'); END IF;
 END IF;
 -- Use the same agent -> invoice lock order as invoice generation.
 SELECT * INTO agent FROM public.agents WHERE id=inv.agent_id FOR UPDATE;
 SELECT * INTO inv FROM public.credit_invoices WHERE id=p_invoice_id FOR UPDATE;
 IF inv.agent_id IS DISTINCT FROM agent.id OR agent.club_id IS NULL
   OR (p_method='wallet' AND actor IS DISTINCT FROM agent.user_id)
   OR (p_method='external' AND NOT engine AND NOT (public.fn_is_club_admin_uid(agent.club_id) OR public.fn_is_platform_admin()))
 THEN RAISE EXCEPTION 'credit_account_changed' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('credit_payment:'||p_operation_id::text,0));
 SELECT * INTO pay FROM public.credit_payments WHERE operation_id=p_operation_id;
 IF NOT FOUND AND p_method='external' THEN
   SELECT * INTO pay FROM public.credit_payments WHERE invoice_id=p_invoice_id AND payment_method='external' AND payment_reference=btrim(p_reference);
 END IF;
 IF pay.id IS NOT NULL THEN
   IF pay.invoice_id<>p_invoice_id OR pay.amount<>p_amount OR pay.payment_method<>p_method
      OR pay.payer_user_id IS DISTINCT FROM actor OR pay.payment_reference IS DISTINCT FROM NULLIF(btrim(p_reference),'')
   THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','operation_conflict'); END IF;
   RETURN jsonb_build_object('ok',true,'success',true,'duplicate',true,'amount',pay.amount,'applied',pay.amount,
     'invoice_id',inv.id,'status',inv.status,'amount_remaining',inv.amount_remaining,'payment',to_jsonb(pay));
 END IF;
 IF inv.status NOT IN('pending','partial','overdue') THEN
   RETURN jsonb_build_object('ok',false,'success',false,'reason',CASE inv.status WHEN 'void' THEN 'invoice_voided' WHEN 'paid' THEN 'already_settled' ELSE 'invoice_not_payable' END);
 END IF;
 IF inv.debt_owed IS NULL OR inv.amount_paid IS NULL OR inv.amount_remaining IS NULL OR agent.credit_used IS NULL
   OR inv.debt_owed::text IN('NaN','Infinity','-Infinity') OR inv.amount_paid::text IN('NaN','Infinity','-Infinity')
   OR inv.amount_remaining::text IN('NaN','Infinity','-Infinity') OR agent.credit_used::text IN('NaN','Infinity','-Infinity')
   OR inv.debt_owed<>round(inv.debt_owed,2) OR inv.amount_paid<>round(inv.amount_paid,2)
   OR agent.credit_used<>round(agent.credit_used,2) OR inv.amount_paid<0 OR agent.credit_used<0
   OR inv.amount_remaining<>inv.debt_owed-inv.amount_paid
 THEN RAISE EXCEPTION 'credit_balance_evidence_invalid' USING ERRCODE='23514'; END IF;
 remaining:=inv.amount_remaining;
 IF p_amount>remaining THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','amount_exceeds_remaining','amount_remaining',remaining); END IF;
 IF p_amount>agent.credit_used THEN RAISE EXCEPTION 'credit_invoice_exceeds_drawn_debt' USING ERRCODE='23514'; END IF;
 IF p_method='wallet' THEN
   old_club:=current_setting('app.ledger_club_id',true);
   PERFORM set_config('app.ledger_club_id',agent.club_id::text,true);
   deducted:=public.atomic_deduct_wallet_and_log(agent.user_id,p_amount,'settlement','Credit Invoice Payment: '||p_invoice_id::text,NULL,NULL,p_invoice_id);
   PERFORM set_config('app.ledger_club_id',COALESCE(old_club,''),true);
   IF deducted IS DISTINCT FROM true THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','insufficient_balance'); END IF;
 END IF;
 remaining:=remaining-p_amount;
 new_status:=CASE WHEN remaining=0 THEN 'paid' ELSE 'partial' END;
 UPDATE public.credit_invoices SET amount_paid=amount_paid+p_amount,amount_remaining=remaining,status=new_status,
  paid_at=CASE WHEN remaining=0 THEN now() ELSE paid_at END WHERE id=p_invoice_id;
 UPDATE public.agents SET credit_used=credit_used-p_amount,updated_at=now() WHERE id=agent.id;
 INSERT INTO public.credit_payments(invoice_id,amount,payment_method,transaction_id,operation_id,payer_user_id,payment_reference)
  VALUES(p_invoice_id,p_amount,p_method,p_operation_id::text,p_operation_id,actor,NULLIF(btrim(p_reference),'')) RETURNING * INTO pay;
 -- The existing payment trigger creates the invoice and both delivery receipts.
 UPDATE public.settlement_invoices SET status=CASE WHEN remaining=0 THEN 'paid' ELSE 'generated' END,updated_at=now()
  WHERE source_credit_invoice_id=p_invoice_id;
 RETURN jsonb_build_object('ok',true,'success',true,'duplicate',false,'amount',p_amount,'applied',p_amount,
  'invoice_id',p_invoice_id,'status',new_status,'amount_remaining',remaining,'credit_used_after',agent.credit_used-p_amount,'payment',to_jsonb(pay));
END $function$
;

-- fn_pay_credit_invoice_from_wallet(uuid,numeric); observed ACL ['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']
CREATE OR REPLACE FUNCTION public.fn_pay_credit_invoice_from_wallet(p_invoice_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 RETURN public.fn_process_credit_invoice_payment(p_invoice_id,p_amount,'wallet',
   md5('legacy-credit-wallet:'||COALESCE(auth.uid()::text,'')||':'||COALESCE(p_invoice_id::text,'')||':'||COALESCE(p_amount::text,''))::uuid,NULL);
END $function$
;

-- fn_apply_credit_payment(uuid,numeric,text); observed ACL ['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']
CREATE OR REPLACE FUNCTION public.fn_apply_credit_payment(p_invoice_id uuid, p_amount numeric, p_method text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 RETURN public.fn_process_credit_invoice_payment(p_invoice_id,p_amount,p_method,
   md5('legacy-credit-apply:'||COALESCE(auth.uid()::text,'')||':'||COALESCE(p_invoice_id::text,'')||':'||COALESCE(p_amount::text,'')||':'||COALESCE(p_method,''))::uuid,NULL);
END $function$
;

-- fn_generate_credit_invoice(uuid,timestamp with time zone,timestamp with time zone,numeric,timestamp with time zone); observed ACL ['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']
CREATE OR REPLACE FUNCTION public.fn_generate_credit_invoice(p_agent_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_debt_owed numeric, p_due_date timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
 v_agent public.agents%ROWTYPE;
 v_row public.credit_invoices%ROWTYPE;
 v_invoiced numeric;
 v_available numeric;
BEGIN
 IF p_agent_id IS NULL THEN RAISE EXCEPTION 'agent_required' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_agent FROM public.agents WHERE id=p_agent_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'agent_not_found' USING ERRCODE='22023'; END IF;
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR
   (auth.uid()<>v_agent.user_id AND NOT public.fn_is_platform_admin()
    AND NOT public.fn_is_club_admin_uid(v_agent.club_id))) THEN
   RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501';
 END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR p_due_date IS NULL
   OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end) OR NOT isfinite(p_due_date)
   OR p_period_start>=p_period_end OR p_period_end>now() OR p_due_date<p_period_end
   OR p_debt_owed IS NULL OR p_debt_owed::text IN ('NaN','Infinity','-Infinity')
   OR p_debt_owed<=0 OR p_debt_owed<>round(p_debt_owed,2) THEN
   RAISE EXCEPTION 'invalid_credit_invoice_terms' USING ERRCODE='22023';
 END IF;
 -- An issued document is immutable. Replay returns its original terms.
 SELECT * INTO v_row FROM public.credit_invoices WHERE agent_id=p_agent_id AND period_end=p_period_end;
 IF FOUND THEN RETURN jsonb_build_object('success',true,'duplicate',true,'invoice',to_jsonb(v_row)); END IF;
 IF COALESCE(v_agent.is_prepaid,false) THEN
   RETURN jsonb_build_object('success',false,'error','prepaid_agent');
 END IF;
 IF v_agent.credit_used IS NULL OR v_agent.credit_used::text IN ('NaN','Infinity','-Infinity')
   OR v_agent.credit_used<0 OR v_agent.credit_used<>round(v_agent.credit_used,2) THEN
   RAISE EXCEPTION 'invalid_drawn_credit' USING ERRCODE='23514';
 END IF;
 SELECT COALESCE(sum(amount_remaining),0) INTO v_invoiced FROM public.credit_invoices
   WHERE agent_id=p_agent_id AND status IN ('pending','partial','overdue','disputed');
 v_available:=v_agent.credit_used-v_invoiced;
 IF v_available<p_debt_owed THEN
   RETURN jsonb_build_object('success',false,'error','debt_already_invoiced_or_not_drawn',
     'credit_used',v_agent.credit_used,'already_invoiced',v_invoiced,'available',v_available);
 END IF;
 INSERT INTO public.credit_invoices(agent_id,period_start,period_end,debt_owed,amount_paid,amount_remaining,status,due_date)
 VALUES(p_agent_id,p_period_start,p_period_end,p_debt_owed,0,p_debt_owed,'pending',p_due_date)
 RETURNING * INTO v_row;
 RETURN jsonb_build_object('success',true,'duplicate',false,'invoice',to_jsonb(v_row));
END $function$
;
