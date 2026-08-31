-- =============================================================================
-- A CREDIT LINE IS SPENDABLE, AND STAFF HOLD AGENT WALLETS
-- =============================================================================
-- 2026-08-31, phase 2 of 7 of the agent credit and promotion lifecycle work.
-- Phase 1 (20260901000001) fixed the biller first, deliberately, so that when
-- credit finally moves the invoice raised against it is already correct.
--
-- THE HEADLINE. agents.credit_used is 0.00 for every agent on this platform and
-- always has been. 111 active agents hold 7,674,633 chips of credit line that
-- has never been drawable, because the function that spends an agent wallet
--
--     fn_agent_wallet_send_core_20260830
--
-- refuses outright when the wallet is short and has never contained the words
-- credit_used or is_prepaid. The rule it needs already exists, fully written
-- and correct, in transfer_chips_agent_to_player - a function with zero callers
-- that debits the wrong account. This migration PORTS that rule onto the live
-- money path rather than inventing a second one.
--
-- DAN'S RULING ON WHAT THE LIMIT MEANS, 2026-08-31, verbatim:
--   "NO, IF THEY GO BELOW THE CREDIT LIMIT, THEY MUST 'SQUARE UP' OR PRE PAY
--    FOR CHIPS FOR THE REST OF THE WEEK."
-- So credit_limit caps OUTSTANDING DEBT, not lifetime borrowing. An agent draws
-- up to credit_limit - credit_used; when the line is exhausted the borrow is
-- refused and they either settle the invoice or fund the wallet themselves for
-- the remainder of the period. credit_invoices periods are exactly 7 days on
-- production, so "the rest of the week" is the billing period already in place,
-- and Phase 1 made fn_apply_credit_payment pay credit_used down - so squaring
-- up genuinely restores the line. Nothing new is needed for that half.
--
-- DAN'S RULING ON RE-PROMOTION (B-01), 2026-08-31: FORCE A FRESH CHOICE. A
-- member who is not currently an agent is being promoted, not re-graded, and a
-- stale agents row from before they were demoted does not restore the old deal
-- silently. Commission, rakeback, prepaid-or-credit and the amount are all
-- chosen again. Re-grading someone who IS already an agent (agent to super
-- agent) still carries their live terms forward - that is not a re-promotion.
--
-- DAN'S RULING ON OWNERS (B-02), 2026-08-31: owners keep earning. The staff
-- no-rakeback rule stays exactly where Dan put it, on co_owner and admin.
--
-- DAN'S CORRECTION THIS MIGRATION UNDOES, verbatim:
--   "OWNERS AND CO OWNERS CAN AND SHOULD HAVE AGENT WALLETS, THAT WAS A
--    MISTAKE."
-- PR #2132 made fn_create_agent and fn_admin_update_agent refuse a staff agent
-- wallet. That refusal is still live in production. It is removed here.
--
-- THE DEFECT NOBODY HAD FOUND, and the reason removing the refusal was not
-- enough on its own. Two triggers on public.agents contradict each other:
--
--   trg_agents_commission_bounds     RAISES if commission_rate is outside the
--                                    union policy band
--   trg_agents_staff_earn_no_rakeback SETS commission_rate to 0 for a co_owner
--                                    or an admin
--
-- Triggers fire in name order, so the band is checked BEFORE the staff rule
-- zeroes the rate. Midway Union sets min_agent_commission = 0.20 and covers 2
-- clubs. Proved against production on 2026-08-31 inside a transaction that was
-- rolled back (CLAUDE.md section 11.5) - no row was kept:
--
--   P1 update-existing-to-zero:   REFUSED [agent commission 0.0000 is outside
--                                 the union policy band (0.20 .. 0.70)]
--   P2 mint-staff-wallet-at-zero: REFUSED [same]
--
-- So in those clubs, promoting anyone who holds an agents row to co_owner or
-- admin FAILS OUTRIGHT today, and a staff agent wallet cannot be minted at all.
-- The band describes what an earning agent may be paid; it has nothing to say
-- about a row the club role law forbids to earn. The band now stands aside for
-- exactly that case and for nothing else.
--
-- WHAT THIS MIGRATION DOES
--   1. The union commission band stops contradicting the staff no-rakeback law.
--   2. fn_ensure_agent_row mints a staff wallet at a rate of zero and with no
--      credit line, instead of inventing the union minimum.
--   3. fn_club_set_member_role gains p_is_prepaid and p_credit_limit and
--      refuses an agent promotion that arrives with no funding choice. The
--      6-argument overload is DROPPED - two signatures would make the PostgREST
--      call ambiguous and break every caller.
--   4. fn_create_agent mints a staff agent wallet without touching their club
--      role. An owner given a wallet is not an owner demoted to 'agent'.
--   5. fn_admin_update_agent relaxes the same refusal and forwards funding.
--   6. fn_agent_wallet_send_core_20260830 draws the shortfall against the line
--      and records credit_drawn in the ledger metadata and the return value.
--   7. fn_agent_wallet_claim_back_phase2_core_20260831 repays credit_used in
--      proportion to the fraction claimed back, so an agent cannot end up
--      holding the returned chips AND the debt.
--
-- NO SCHEMA CHANGE. Every new fact travels in chip_transactions.metadata, which
-- is already jsonb, so scripts/ci/supabase-columns-manifest.json is untouched
-- and no table lock is taken. That matters here: club_members is realtime
-- published and DDL on it deadlocks against realtime.subscription (this
-- programme hit that twice on 2026-08-27). CREATE OR REPLACE FUNCTION takes no
-- table lock at all.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '25s';

-- -----------------------------------------------------------------------------
-- 1. The union band stops fighting the staff no-rakeback law
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

  -- A co-owner and an admin earn nothing, by Dan's rule and by
  -- trg_agents_staff_earn_no_rakeback, which sets both of their rates to zero.
  -- The union band says what an EARNING agent may be paid, so it has nothing to
  -- say about a row that is forbidden to earn. Without this exemption the two
  -- rules contradict and the band wins by firing first on name order, which
  -- made promotion to co_owner impossible in any club under a union with a
  -- non-zero minimum. This stands aside ONLY for a zero rate on a member the
  -- club already records as staff; every other row is still bound by the band.
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
-- 2. A minted staff wallet gets a rate of zero, not the union minimum
-- -----------------------------------------------------------------------------
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
$function$;

-- fn_ensure_agent_row takes no actor and asks for none, deliberately: the
-- cashier calls it having already decided who may act and while holding the
-- lock, so a second opinion here would be a different answer to a question
-- already settled. That makes it an internal helper, and an internal helper a
-- browser can reach is a writer with no caller. CREATE OR REPLACE does not
-- reset an existing ACL, but a fresh apply of this file elsewhere would leave
-- the default PUBLIC EXECUTE in place, so the grant is stated rather than
-- assumed. PUBLIC is named as well as the roles: revoking one role while
-- PUBLIC still holds it reads as a fix and does nothing.
REVOKE ALL ON FUNCTION public.fn_ensure_agent_row(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ensure_agent_row(uuid, uuid, text)
  TO service_role;

-- -----------------------------------------------------------------------------
-- 3. The promotion assigns the funding, or it does not happen
-- -----------------------------------------------------------------------------
-- The 6-argument overload is dropped rather than left beside the new one.
-- PostgREST resolves an RPC by the named arguments in the request body, and two
-- signatures differing only by trailing defaults make every existing 3- and
-- 5-argument call ambiguous (PGRST203). One signature, always.
DROP FUNCTION IF EXISTS public.fn_club_set_member_role(uuid, uuid, text, uuid, numeric, numeric);

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
                             'commission_rate', v_comm, 'player_rakeback_rate', v_rake,
                             'is_prepaid', v_prepaid, 'credit_limit', v_limit,
                             'funding_rechosen', COALESCE(v_fresh, false)),
          'Role changed via fn_club_set_member_role');

  RETURN jsonb_build_object('success', true, 'old_role', v_old_role, 'new_role', p_role,
    'commission_rate', v_comm, 'player_rakeback_rate', v_rake,
    'is_prepaid', v_prepaid, 'credit_limit', v_limit,
    'reports_to', CASE WHEN v_set_upline THEN v_actor ELSE NULL END);
END;
$function$;

-- A DROP takes the ACL with it, and CREATE puts back the Postgres default:
-- EXECUTE to PUBLIC. The estate's autorevoke event trigger strips that on a
-- plain CREATE OR REPLACE, but this path is a DROP followed by a CREATE and it
-- did not fire, so granting the two roles alone left PUBLIC and anon holding
-- EXECUTE as well. Caught by the Supabase security advisor
-- (anon_security_definer_function_executable) during the phase 2 audit pass.
--
-- It was not exploitable: anon has no auth.uid(), and auth.role() is 'anon'
-- rather than 'service_role', so the caller-supplied actor is refused and the
-- function answers "actor identity required". It is closed anyway, because the
-- signature this replaced never granted anon, and a door that is only shut by
-- an argument check further in is still a door.
--
-- PUBLIC is named as well as the role: revoking anon while PUBLIC still holds
-- the privilege reads as a fix and changes nothing.
REVOKE ALL ON FUNCTION public.fn_club_set_member_role(uuid, uuid, text, uuid, numeric, numeric, boolean, numeric)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_set_member_role(uuid, uuid, text, uuid, numeric, numeric, boolean, numeric)
  TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Staff hold agent wallets, and minting one does not change their title
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 5. The agent panel forwards the funding, and stops overruling Dan on owners
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_admin_update_agent(p_agent_id uuid, p_status text DEFAULT NULL::text, p_role text DEFAULT NULL::text, p_credit_limit numeric DEFAULT NULL::numeric, p_commission_rate numeric DEFAULT NULL::numeric, p_player_rakeback_rate numeric DEFAULT NULL::numeric, p_assigned_by uuid DEFAULT NULL::uuid, p_credit_reason text DEFAULT NULL::text, p_is_prepaid boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_club_id uuid; v_user_id uuid; v_parent uuid; v_old_limit numeric; v_parent_limit numeric;
  v_member_role text; v_role_res jsonb;
  v_prepaid_after boolean; v_limit_after numeric;
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

  -- Prepaid and a line are mutually exclusive, whichever of the two this call
  -- happens to be changing. Reading the resulting pair rather than only the
  -- supplied one is what stops "raise the limit" quietly creating a prepaid
  -- agent with a credit line she can never draw.
  SELECT COALESCE(p_is_prepaid, is_prepaid), COALESCE(p_credit_limit, credit_limit)
    INTO v_prepaid_after, v_limit_after
    FROM agents WHERE id = p_agent_id;
  IF COALESCE(v_prepaid_after, false) AND COALESCE(v_limit_after, 0) <> 0 THEN
    RETURN jsonb_build_object('success', false,
      'error', 'a prepaid agent carries no credit line. Move them to credit first, or set the limit to 0.');
  END IF;

  SELECT role INTO v_member_role FROM club_members
   WHERE club_id = v_club_id AND user_id = v_user_id;

  -- Dan, B-02, 2026-08-31: OWNERS KEEP EARNING. This list used to include
  -- 'owner', which no rule anywhere else does: trg_agents_staff_earn_no_rakeback
  -- covers co_owner and admin only, and one live owner already holds an active
  -- agents row at 0.30 / 0.20 that this branch would have refused to edit.
  IF v_member_role IN ('co_owner','admin')
     AND (COALESCE(p_commission_rate, 0) <> 0 OR COALESCE(p_player_rakeback_rate, 0) <> 0)
     AND p_role IS NULL THEN
    RETURN jsonb_build_object('success', false,
      'error', 'this member is club staff and earns no rakeback. Change their role first.');
  END IF;

  -- The role change goes through the one door, so the grant matrix, the
  -- downline guard, the funding choice and the audit row apply here too. The
  -- arguments are forwarded EXACTLY as given rather than defaulted from the
  -- existing row: on a re-promotion the row holds the deal from before the
  -- demotion, and B-01 says that deal does not come back on its own. When this
  -- is a re-grade between agent tiers the callee carries the live terms forward
  -- itself, so passing NULL there still does the right thing.
  IF p_role IS NOT NULL AND v_member_role IS NOT NULL AND v_member_role <> p_role THEN
    v_role_res := public.fn_club_set_member_role(
      v_club_id, v_user_id, p_role, v_caller,
      p_commission_rate, p_player_rakeback_rate, p_is_prepaid, p_credit_limit);
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

-- -----------------------------------------------------------------------------
-- 6. The credit line becomes spendable
-- -----------------------------------------------------------------------------
-- The rule below is PORTED, not invented. transfer_chips_agent_to_player has
-- carried it correctly since before this programme started - it has zero
-- callers and debits the wrong account, which is why it never mattered. Its
-- shape is kept deliberately, including COALESCE(is_prepaid, true): an unknown
-- funding arrangement refuses to lend rather than lending freely.
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_send_core_20260830(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
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
  end if;

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
$function$;

-- -----------------------------------------------------------------------------
-- 6b. The outer send answers a retry the same way the core does
-- -----------------------------------------------------------------------------
-- This wrapper answers a replayed op_id from the ledger row itself and never
-- reaches the core, so without this a retried send would silently drop the
-- credit fields that the first attempt returned. A caller cannot tell a retry
-- from a first attempt, so the two must not answer differently.
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
$function$;

-- -----------------------------------------------------------------------------
-- 7. Claiming chips back pays the borrowing back too
-- -----------------------------------------------------------------------------
-- Without this an agent who sent on credit and immediately claimed it back
-- would hold the returned chips AND the whole debt: the wallet gains, and
-- credit_used never moves. Repayment is proportional to the fraction claimed,
-- so a partial claim back settles a partial borrowing, and the last claim on a
-- send clears whatever rounding left behind.
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_claim_back_phase2_core_20260831(p_club_id uuid, p_transaction_id uuid, p_amount numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
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

  -- Every chip returns: what is not repaying a debt becomes float.
  update public.agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + (v_take - v_repay),
         credit_used          = greatest(coalesce(credit_used, 0) - v_repay, 0),
         updated_at = now()
   where id = v_my_agent_id
   returning agent_wallet_balance, credit_used into v_float_after, v_credit_after;

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
$function$;

-- -----------------------------------------------------------------------------
-- 8. Proof
-- -----------------------------------------------------------------------------
-- Every assertion here is a bug this migration exists to fix. If one raises,
-- the migration aborts and nothing in it is applied.
DO $verify$
DECLARE
  v_n int;
BEGIN
  -- ONE signature. Two overloads make the PostgREST call ambiguous.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_club_set_member_role';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_club_set_member_role has % signatures, expected exactly 1', v_n;
  END IF;

  IF pg_get_function_identity_arguments(
       'public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric,boolean,numeric)'::regprocedure
     ) !~ 'p_is_prepaid' THEN
    RAISE EXCEPTION 'fn_club_set_member_role does not take a funding choice';
  END IF;

  IF NOT has_function_privilege('authenticated',
       'public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric,boolean,numeric)'::regprocedure,
       'EXECUTE') THEN
    RAISE EXCEPTION 'the promote screen cannot call fn_club_set_member_role: EXECUTE was not re-granted after the DROP';
  END IF;

  -- The other half of that: a DROP resets the ACL to the PUBLIC default, and a
  -- grant to two roles does not take it away again.
  IF has_function_privilege('anon',
       'public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric,boolean,numeric)'::regprocedure,
       'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still execute fn_club_set_member_role: the DROP restored the PUBLIC default';
  END IF;

  -- Dan: "OWNERS AND CO OWNERS CAN AND SHOULD HAVE AGENT WALLETS."
  IF pg_get_functiondef(
       'public.fn_create_agent(uuid,uuid,text,uuid,numeric,numeric,numeric,boolean)'::regprocedure
     ) ~ 'earns no rakeback' THEN
    RAISE EXCEPTION 'fn_create_agent still refuses to mint a staff agent wallet';
  END IF;

  -- B-02: owners keep earning. The refusal must no longer name them.
  IF pg_get_functiondef(
       'public.fn_admin_update_agent(uuid,text,text,numeric,numeric,numeric,uuid,text,boolean)'::regprocedure
     ) ~ 'v_member_role IN \(''owner''' THEN
    RAISE EXCEPTION 'fn_admin_update_agent still bars an owner from earning';
  END IF;

  -- The credit line is spendable.
  IF pg_get_functiondef(
       'public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid)'::regprocedure
     ) !~ 'credit_used' THEN
    RAISE EXCEPTION 'fn_agent_wallet_send still cannot draw against a credit line';
  END IF;
  IF pg_get_functiondef(
       'public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid)'::regprocedure
     ) !~ 'credit_drawn' THEN
    RAISE EXCEPTION 'fn_agent_wallet_send does not record what it borrowed';
  END IF;

  -- And the claim back repays it.
  IF pg_get_functiondef(
       'public.fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid)'::regprocedure
     ) !~ 'credit_used' THEN
    RAISE EXCEPTION 'a claim back would leave the agent holding the chips and the debt';
  END IF;

  -- The union band no longer contradicts the staff no-rakeback law.
  IF pg_get_functiondef('public.fn_enforce_agent_commission_bounds()'::regprocedure)
       !~ 'co_owner' THEN
    RAISE EXCEPTION 'the union commission band still refuses a staff rate of zero';
  END IF;

  -- A staff wallet is minted with no line, so it cannot borrow by accident.
  IF pg_get_functiondef('public.fn_ensure_agent_row(uuid,uuid,text)'::regprocedure)
       !~ 'is_prepaid' THEN
    RAISE EXCEPTION 'fn_ensure_agent_row still mints a wallet without stating its funding';
  END IF;

  RAISE NOTICE 'phase 2 of 7: the credit line is spendable and staff hold agent wallets';
END
$verify$;

COMMIT;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- Required because this migration DROPs a function signature, which is the one
-- change here that cannot be undone by simply replacing a body.
--
-- Nothing in this migration alters a table, a column, a constraint or a row, so
-- there is no data to unwind: every statement above is CREATE OR REPLACE
-- FUNCTION, one DROP FUNCTION, and one GRANT. To go back:
--
--   1. Restore the 6-argument fn_club_set_member_role and drop the 8-argument
--      one, in that order, inside a single transaction:
--
--        BEGIN;
--        DROP FUNCTION IF EXISTS public.fn_club_set_member_role(
--          uuid, uuid, text, uuid, numeric, numeric, boolean, numeric);
--        -- then re-create the body from
--        --   20260831235997_promotion_assigns_rakeback_and_staff_earn_none.sql
--        GRANT EXECUTE ON FUNCTION public.fn_club_set_member_role(
--          uuid, uuid, text, uuid, numeric, numeric) TO authenticated, service_role;
--        COMMIT;
--
--      fn_create_agent and fn_admin_update_agent call it with 8 arguments after
--      this migration, so they must be restored in the SAME transaction or both
--      will fail at runtime with 42883. promote_member passes 4 and is
--      unaffected either way.
--
--   2. Restore fn_agent_wallet_send_core_20260830,
--      fn_agent_wallet_send_phase2_core_20260831,
--      fn_agent_wallet_claim_back_phase2_core_20260831, fn_ensure_agent_row and
--      fn_enforce_agent_commission_bounds from 20260830 / 20260831 / the
--      original definitions. Replacing a body needs no lock and no unwinding.
--
-- ONE THING A ROLLBACK DOES NOT UNDO. Once credit has been drawn,
-- agents.credit_used is no longer 0 and reverting the send function does not
-- return those chips - the agent has them, and the debt is real and correctly
-- recorded. That is the intended outcome, not damage: fn_apply_credit_payment
-- settles it. Revert the code if it misbehaves; do not zero credit_used to
-- "clean up", because the chips it accounts for have already left the wallet.
