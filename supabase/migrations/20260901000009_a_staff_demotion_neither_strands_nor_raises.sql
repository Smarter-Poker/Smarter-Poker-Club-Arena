-- =============================================================================
-- A STAFF DEMOTION NEITHER STRANDS CHIPS NOR RAISES
-- =============================================================================
-- 2026-08-31, phase 4 follow-up, found by probing my own phase 4 change rather
-- than trusting it. Two defects, one of them a live unhandled exception.
--
-- DEFECT 1 - THE DEMOTION GUARD MISSED THE PEOPLE PHASE 2 GAVE WALLETS TO.
-- 20260901000008 refused a stranding demotion only when the OLD role was one of
-- the three agent tiers. But phase 2 exists precisely because a co-owner and an
-- admin hold agent wallets - Dan: "OWNERS AND CO OWNERS CAN AND SHOULD HAVE
-- AGENT WALLETS, THAT WAS A MISTAKE." Demoting a co-owner holding float
-- straight to player sailed past the guard and stranded the chips, which is the
-- one thing phase 4 was written to prevent. Any role that is not already
-- 'player' can be holding a wallet, and the guard now says so.
--
-- DEFECT 2 - AND THAT DEMOTION RAISED, IN PRODUCTION, ON A REAL PATH.
-- Probed against production (rolled back), demoting a co-owner to player in a
-- club under Midway Union answered:
--
--     agent commission 0.0000 is outside the union policy band (0.20 .. 0.70)
--
-- an unhandled P0001 out of fn_enforce_agent_commission_bounds, not a refusal
-- the client can read.
--
-- The cause is mine. Phase 2 taught that trigger to stand aside for a rate of
-- zero on a member the club records as staff. But fn_club_set_member_role
-- updates club_members FIRST and agents SECOND, so by the time the trigger
-- fires the member is already recorded as 'player' and the exemption no longer
-- applies. The row's commission was zeroed while they were staff, and 0 is
-- outside a union band with a non-zero minimum.
--
-- THE REAL BUG IS OLDER THAN EITHER. trg_agents_commission_bounds is BEFORE
-- UPDATE OF commission_rate, and Postgres fires that for any UPDATE whose SET
-- list NAMES the column - even when the value is identical. So an unrelated
-- write that merely mentions commission_rate re-validates a rate nobody
-- changed, against a band that historical data may never have satisfied. That
-- is why the 9 out-of-band rows Dan has not yet ruled on are a latent trap:
-- any write touching those rows can raise.
--
-- A policy band governs a rate being SET. It has no business re-judging a value
-- that is not changing, so the trigger now returns early when the rate is
-- unchanged. That fixes this demotion, and every other write that happens to
-- name the column, without weakening the band for anyone actually setting one.
--
-- No table is touched. Two function bodies, unchanged signatures.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '25s';

-- -----------------------------------------------------------------------------
-- 1. A band judges a rate being set, not one sitting still
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_enforce_agent_commission_bounds()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid; v_min numeric; v_max numeric; v_rate numeric;
BEGIN
  IF NEW.commission_rate IS NULL THEN RETURN NEW; END IF;

  -- THE RATE IS NOT CHANGING, SO THERE IS NOTHING TO JUDGE.
  -- This trigger is BEFORE UPDATE OF commission_rate, and Postgres fires that
  -- for any UPDATE whose SET list names the column, identical value or not.
  -- Without this, an unrelated write - a status change, a demotion, a parent
  -- reassignment - re-validates a rate nobody touched against a band the row
  -- may never have satisfied, and raises P0001 into a caller that has no idea
  -- why. It is how demoting a co-owner to player failed outright in any club
  -- under a union with a non-zero minimum.
  IF TG_OP = 'UPDATE' AND NEW.commission_rate IS NOT DISTINCT FROM OLD.commission_rate THEN
    RETURN NEW;
  END IF;

  -- A co-owner and an admin earn nothing, by Dan's rule and by
  -- trg_agents_staff_earn_no_rakeback, which sets both of their rates to zero.
  -- The union band says what an EARNING agent may be paid, so it has nothing to
  -- say about a row that is forbidden to earn.
  IF NEW.commission_rate = 0 AND EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.club_id = NEW.club_id
       AND cm.user_id = NEW.user_id
       AND cm.role IN ('co_owner', 'admin')
  ) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(uc.union_id, c.union_id) INTO v_union
    FROM clubs c LEFT JOIN union_clubs uc ON uc.club_id = c.id
   WHERE c.id = NEW.club_id LIMIT 1;

  IF v_union IS NULL THEN RETURN NEW; END IF;   -- standalone club: no policy

  v_min := public.fn_union_setting(v_union, 'min_agent_commission', 0);
  v_max := public.fn_union_setting(v_union, 'max_agent_commission', 1);

  -- Rates may be expressed as a fraction (0.5) or whole percent (50).
  v_rate := CASE WHEN NEW.commission_rate > 1 THEN NEW.commission_rate / 100.0
                 ELSE NEW.commission_rate END;

  IF v_rate < v_min OR v_rate > v_max THEN
    RAISE EXCEPTION 'agent commission % is outside the union policy band (% .. %)',
      v_rate, v_min, v_max
      USING HINT = 'Change unions.settings.min_agent_commission / max_agent_commission to widen the band.';
  END IF;

  RETURN NEW;
END $function$;

-- -----------------------------------------------------------------------------
-- 2. The demotion guard covers every role that can hold a wallet
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_club_set_member_role(
  p_club_id             uuid,
  p_user_id             uuid,
  p_role                text,
  p_actor_user_id       uuid    DEFAULT NULL,
  p_commission_rate     numeric DEFAULT NULL,
  p_player_rakeback_rate numeric DEFAULT NULL,
  p_is_prepaid          boolean DEFAULT NULL,
  p_credit_limit        numeric DEFAULT NULL
)
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
$function$;
DO $verify$
DECLARE
  v_def text := pg_get_functiondef(
    'public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric,boolean,numeric)'::regprocedure);
BEGIN
  IF v_def !~ 'v_old_role <> ''player''' THEN
    RAISE EXCEPTION 'the demotion guard still misses staff who hold an agent wallet';
  END IF;
  IF v_def !~ 'p_role = ''player'' AND v_old_role <> ''player''' THEN
    RAISE EXCEPTION 'an agents row is left active for somebody who is now a player';
  END IF;
  IF pg_get_functiondef('public.fn_enforce_agent_commission_bounds()'::regprocedure)
       !~ 'IS NOT DISTINCT FROM OLD.commission_rate' THEN
    RAISE EXCEPTION 'the union band still re-judges a rate that is not changing';
  END IF;
  RAISE NOTICE 'a staff demotion neither strands chips nor raises';
END
$verify$;

COMMIT;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- Two function bodies, unchanged signatures, no data written. Restore
-- fn_enforce_agent_commission_bounds and fn_club_set_member_role from
-- 20260901000008 in a single transaction.
--
-- Reverting re-opens both: demoting a co-owner who holds float would strand it
-- again, and in any club under a union with a non-zero minimum commission that
-- same demotion would raise P0001 instead of answering.
