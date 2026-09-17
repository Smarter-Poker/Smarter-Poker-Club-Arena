-- Guard agent agreement writes without rewriting any existing commercial rate.
-- Existing cap conflicts may be improved, but not introduced or worsened.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_create_agent(uuid,uuid,text,uuid,numeric,numeric,numeric,boolean)'::regprocedure))<>'187ba10367041b03c9b1a815f158f1f0'
 OR md5(pg_get_functiondef('public.fn_admin_update_agent(uuid,text,text,numeric,numeric,numeric,uuid,text,boolean)'::regprocedure))<>'d1ce4c9a2245cc60f6d02481ee73db52'
 OR md5(pg_get_functiondef('public.fn_agent_downline_commission(uuid)'::regprocedure))<>'12ea17703c4362a6c2499a8afba59f50' THEN
  RAISE EXCEPTION 'agent agreement function preimage changed';END IF;
 IF EXISTS(SELECT 1 FROM public.agents c LEFT JOIN public.agents p ON p.id=c.parent_agent_id
   WHERE c.parent_agent_id IS NOT NULL AND (p.id IS NULL OR c.club_id IS DISTINCT FROM p.club_id)) THEN
  RAISE EXCEPTION 'existing agent parent scope requires reconciliation';END IF;
 IF EXISTS(WITH RECURSIVE walk AS (
   SELECT id AS start_id,id,parent_agent_id,ARRAY[id] AS path,false AS cycle FROM public.agents
   UNION ALL SELECT w.start_id,a.id,a.parent_agent_id,w.path||a.id,a.id=ANY(w.path)
   FROM walk w JOIN public.agents a ON a.id=w.parent_agent_id WHERE NOT w.cycle
  ) SELECT 1 FROM walk WHERE cycle) THEN
  RAISE EXCEPTION 'existing agent hierarchy cycle requires reconciliation';END IF;
END $guard$;
CREATE UNIQUE INDEX agents_agreement_club_and_id ON public.agents(club_id,id);
ALTER TABLE public.agents ADD CONSTRAINT agents_parent_in_same_club
 FOREIGN KEY(club_id,parent_agent_id) REFERENCES public.agents(club_id,id) NOT VALID;
ALTER TABLE public.agents VALIDATE CONSTRAINT agents_parent_in_same_club;

CREATE FUNCTION public.fn_guard_agent_agreement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE parent public.agents%ROWTYPE;child record;field text;new_value numeric;old_value numeric;parent_value numeric;child_value numeric;
 old_terms jsonb;new_terms jsonb;parent_terms jsonb;new_edge boolean;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.club_id IS DISTINCT FROM OLD.club_id) THEN
  RAISE EXCEPTION 'agent financial account identity is immutable; create a separate account for another club or user' USING ERRCODE='23514';END IF;
 -- All agreement RPCs take this same club lock before reading terms. Direct
 -- writes also pass this guard; the financial account's club is immutable.
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||NEW.club_id::text,0));
 old_terms:=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 new_terms:=to_jsonb(NEW);
 new_edge:=TG_OP='INSERT' OR NEW.parent_agent_id IS DISTINCT FROM OLD.parent_agent_id OR NEW.club_id IS DISTINCT FROM OLD.club_id;
 IF NEW.parent_agent_id IS NOT NULL THEN
  SELECT * INTO parent FROM public.agents WHERE id=NEW.parent_agent_id AND club_id=NEW.club_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'parent agent must belong to the same club' USING ERRCODE='23514';END IF;
  IF NEW.parent_agent_id=NEW.id OR EXISTS(WITH RECURSIVE chain AS (
    SELECT id,parent_agent_id FROM public.agents WHERE id=NEW.parent_agent_id AND club_id=NEW.club_id
    UNION SELECT a.id,a.parent_agent_id FROM public.agents a JOIN chain c ON a.id=c.parent_agent_id WHERE a.club_id=NEW.club_id
   ) SELECT 1 FROM chain WHERE id=NEW.id) THEN
   RAISE EXCEPTION 'agent hierarchy cannot contain a cycle' USING ERRCODE='23514';END IF;
  IF new_edge AND (parent.role='sub_agent' OR parent.status IS DISTINCT FROM 'active') THEN
   RAISE EXCEPTION 'new parent must be an active agent or super agent' USING ERRCODE='23514';END IF;
  parent_terms:=to_jsonb(parent);
 END IF;
 IF NEW.role='sub_agent' AND (TG_OP='INSERT' OR NEW.role IS DISTINCT FROM OLD.role)
  AND EXISTS(SELECT 1 FROM public.agents c WHERE c.parent_agent_id=NEW.id) THEN
  RAISE EXCEPTION 'a sub-agent cannot have agent children' USING ERRCODE='23514';END IF;

 FOREACH field IN ARRAY ARRAY['commission_rate','player_rakeback_rate','credit_limit'] LOOP
  new_value:=(new_terms->>field)::numeric;old_value:=(old_terms->>field)::numeric;
  IF TG_OP='INSERT' OR new_value IS DISTINCT FROM old_value THEN
   IF new_value IS NULL OR new_value::text IN('NaN','Infinity','-Infinity') OR new_value<0
    OR (field='credit_limit' AND new_value<>round(new_value,2))
    OR (field='commission_rate' AND new_value>0.70)
    OR (field='player_rakeback_rate' AND new_value>0.50) THEN
    RAISE EXCEPTION 'invalid agent agreement value: %',field USING ERRCODE='23514';END IF;
  END IF;
  IF NEW.parent_agent_id IS NOT NULL AND (new_edge OR new_value IS DISTINCT FROM old_value) THEN
   parent_value:=(parent_terms->>field)::numeric;
   IF parent_value IS NOT NULL AND greatest(new_value-parent_value,0)>
      (CASE WHEN new_edge THEN 0 ELSE greatest(old_value-parent_value,0) END) THEN
    RAISE EXCEPTION 'agent % cannot exceed or worsen its parent cap',field USING ERRCODE='23514';END IF;
  END IF;
  IF TG_OP='UPDATE' AND new_value IS DISTINCT FROM old_value THEN
   FOR child IN SELECT to_jsonb(a) AS terms FROM public.agents a WHERE a.parent_agent_id=NEW.id AND a.club_id=NEW.club_id LOOP
    child_value:=(child.terms->>field)::numeric;
    IF child_value IS NOT NULL AND greatest(child_value-new_value,0)>greatest(child_value-old_value,0) THEN
     RAISE EXCEPTION 'agent % cannot be reduced below an existing child agreement',field USING ERRCODE='23514';END IF;
   END LOOP;
  END IF;
 END LOOP;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_guard_agent_agreement() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER zz_guard_agent_agreement BEFORE INSERT OR UPDATE OF id,user_id,club_id,parent_agent_id,role,commission_rate,player_rakeback_rate,credit_limit ON public.agents FOR EACH ROW EXECUTE FUNCTION public.fn_guard_agent_agreement();

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
  PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
  IF NOT EXISTS (SELECT 1 FROM clubs c WHERE c.id=p_club_id AND (c.owner_id=v_caller
     OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id=p_club_id AND cm.user_id=v_caller AND cm.role IN ('owner','co_owner','admin') AND cm.status IN ('active','approved')))) THEN
    RETURN jsonb_build_object('success',false,'error','not authorized to manage this club''s agents'); END IF;
  IF p_role IS NULL OR p_role NOT IN ('super_agent','agent','sub_agent') THEN RETURN jsonb_build_object('success',false,'error','invalid role'); END IF;
  IF p_commission_rate IS NULL OR p_commission_rate < 0 OR p_commission_rate > 0.7 THEN RETURN jsonb_build_object('success',false,'error','commission rate must be 0-0.7'); END IF;
  IF p_player_rakeback_rate IS NULL OR p_player_rakeback_rate < 0 OR p_player_rakeback_rate > 0.5 THEN RETURN jsonb_build_object('success',false,'error','rakeback rate must be 0-0.5'); END IF;
  IF p_credit_limit IS NULL OR p_credit_limit::text IN ('NaN','Infinity','-Infinity') OR p_credit_limit < 0 OR p_credit_limit <> round(p_credit_limit,2) THEN RETURN jsonb_build_object('success',false,'error','credit_limit must be finite, nonnegative and in whole chip cents'); END IF;
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
      FROM agents WHERE id=p_parent_agent_id AND club_id=p_club_id AND status='active';
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
      RAISE EXCEPTION 'agent_role_change_refused' USING ERRCODE='PAG01';
    END IF;
  END IF;

  RETURN jsonb_build_object('success',true,'agent_id',v_new_id,
    'club_role_unchanged', v_is_staff, 'club_role', v_member_role);
EXCEPTION WHEN SQLSTATE 'PAG01' THEN
  -- This block rolls back the agent insert/update and every role-callee write.
  RETURN COALESCE(v_role_res,jsonb_build_object('success',false,'error','role change refused'));
END;
$function$;

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
  v_prepaid_now boolean; v_limit_now numeric; v_used_now numeric;
  v_prepaid_after boolean; v_limit_after numeric;
  v_touches_funding boolean;
BEGIN
  IF p_agent_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'agent id required'); END IF;
  IF v_caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'authentication required'); END IF;
  SELECT club_id, user_id, parent_agent_id, credit_limit INTO v_club_id, v_user_id, v_parent, v_old_limit
  FROM agents WHERE id = p_agent_id;
  IF v_club_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'agent not found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||v_club_id::text,0));
  SELECT user_id,parent_agent_id,credit_limit INTO v_user_id,v_parent,v_old_limit FROM public.agents WHERE id=p_agent_id AND club_id=v_club_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','agent scope changed');END IF;
  IF NOT EXISTS (
    SELECT 1 FROM clubs c WHERE c.id = v_club_id AND (
      c.owner_id = v_caller
      OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = v_club_id AND cm.user_id = v_caller
                 AND cm.role IN ('owner','co_owner','admin') AND cm.status IN ('active','approved')))
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to manage this club''s agents');
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('active','suspended','frozen') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid status'); END IF;
  IF p_role IS NOT NULL AND p_role NOT IN ('super_agent','agent','sub_agent') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid role'); END IF;
  IF p_credit_limit IS NOT NULL AND (p_credit_limit::text IN ('NaN','Infinity','-Infinity') OR p_credit_limit < 0 OR p_credit_limit <> round(p_credit_limit,2)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'credit_limit must be finite, nonnegative and in whole chip cents'); END IF;
  -- The table CHECK is 0..0.70 and 0..0.50. Validating against 0..100 let a
  -- caller who meant "25%" past this line and into a raw 23514 from Postgres.
  IF p_commission_rate IS NOT NULL AND (p_commission_rate < 0 OR p_commission_rate > 0.70) THEN
    RETURN jsonb_build_object('success', false, 'error', 'commission_rate must be between 0 and 0.70'); END IF;
  IF p_player_rakeback_rate IS NOT NULL AND (p_player_rakeback_rate < 0 OR p_player_rakeback_rate > 0.50) THEN
    RETURN jsonb_build_object('success', false, 'error', 'player_rakeback_rate must be between 0 and 0.50'); END IF;

  -- ---------------------------------------------------------------------------
  -- THE FUNDING PAIR
  -- ---------------------------------------------------------------------------
  SELECT COALESCE(is_prepaid, false), COALESCE(credit_limit, 0), COALESCE(credit_used, 0)
    INTO v_prepaid_now, v_limit_now, v_used_now
    FROM agents WHERE id = p_agent_id;

  v_touches_funding := (p_is_prepaid IS NOT NULL OR p_credit_limit IS NOT NULL);
  v_prepaid_after   := COALESCE(p_is_prepaid, v_prepaid_now);
  v_limit_after     := COALESCE(p_credit_limit, v_limit_now);

  IF v_touches_funding THEN
    -- Granting a line IS the choice of credit. Refusing here instead would
    -- dead-end every "raise this agent's limit" call against a prepaid agent,
    -- and no screen moves them to credit first.
    IF p_is_prepaid IS NULL AND COALESCE(p_credit_limit, 0) > 0 THEN
      v_prepaid_after := false;
    END IF;

    -- And moving somebody TO prepaid closes the line, for the same reason in
    -- reverse: prepaid and a line cannot both be true.
    IF COALESCE(p_is_prepaid, false) AND p_credit_limit IS NULL THEN
      v_limit_after := 0;
    END IF;

    -- Saying both, and contradicting yourself, is still a mistake worth naming.
    IF v_prepaid_after AND COALESCE(v_limit_after, 0) <> 0 THEN
      RETURN jsonb_build_object('success', false,
        'error', 'a prepaid agent carries no credit line. Send prepaid on its own, or a credit limit on its own.');
    END IF;

    -- The pair that can send nothing at all.
    IF NOT v_prepaid_after AND COALESCE(v_limit_after, 0) <= 0 THEN
      RETURN jsonb_build_object('success', false, 'needs_funding', true,
        'error', 'an agent on credit needs a limit greater than 0. Set them prepaid instead, or give a limit.');
    END IF;

    -- A debt outlives the line it was drawn against, so the line cannot simply
    -- be taken away while it is still owed.
    IF v_prepaid_after AND v_used_now > 0 THEN
      RETURN jsonb_build_object('success', false,
        'error', 'this agent still owes ' || trim(to_char(v_used_now, 'FM999,999,999,990.00'))
                 || ' chips on their credit line. Settle the invoice before moving them to prepaid.',
        'credit_used', v_used_now);
    END IF;

    -- Lowering a limit below what has already been drawn violates check_credit
    -- and used to reach the client as a raw 23514 with no explanation.
    IF NOT v_prepaid_after AND v_limit_after < v_used_now THEN
      RETURN jsonb_build_object('success', false,
        'error', 'that limit is below the ' || trim(to_char(v_used_now, 'FM999,999,999,990.00'))
                 || ' chips already drawn. Take a payment first, or set a limit of at least that much.',
        'credit_used', v_used_now, 'requested_limit', v_limit_after);
    END IF;
  END IF;

  IF v_touches_funding AND v_parent IS NOT NULL THEN
    SELECT credit_limit INTO v_parent_limit FROM agents WHERE id = v_parent AND club_id=v_club_id;
    IF v_parent_limit IS NOT NULL AND v_limit_after > v_parent_limit THEN
      RETURN jsonb_build_object('success', false, 'error', 'credit limit cannot exceed parent agent limit');
    END IF;
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
  -- RESOLVED funding pair is forwarded, not the raw arguments: the callee
  -- applies the same prepaid-or-a-line rule, and sending it a bare NULL where
  -- this call has already decided would make the two disagree.
  IF p_role IS NOT NULL AND v_member_role IS NOT NULL AND v_member_role <> p_role THEN
    v_role_res := public.fn_club_set_member_role(
      v_club_id, v_user_id, p_role, v_caller,
      p_commission_rate, p_player_rakeback_rate,
      CASE WHEN v_touches_funding THEN v_prepaid_after ELSE NULL END,
      CASE WHEN v_touches_funding THEN v_limit_after   ELSE NULL END);
    IF NOT COALESCE((v_role_res ->> 'success')::boolean, false) THEN
      RAISE EXCEPTION 'agent_role_change_refused' USING ERRCODE='PAG01';
    END IF;
  END IF;

  UPDATE agents SET
    status = COALESCE(p_status, status),
    role = COALESCE(p_role, role),
    credit_limit = CASE WHEN v_touches_funding THEN v_limit_after ELSE credit_limit END,
    commission_rate = COALESCE(p_commission_rate, commission_rate),
    player_rakeback_rate = COALESCE(p_player_rakeback_rate, player_rakeback_rate),
    is_prepaid = CASE WHEN v_touches_funding THEN v_prepaid_after ELSE is_prepaid END,
    updated_at = now()
  WHERE id = p_agent_id;

  IF v_touches_funding AND v_limit_after <> COALESCE(v_old_limit, -1) THEN
    INSERT INTO credit_assignments (agent_id, assigned_by, old_limit, new_limit, reason)
    VALUES (p_agent_id, v_caller, v_old_limit, v_limit_after, p_credit_reason);
  END IF;

  RETURN jsonb_build_object('success', true, 'agent_id', p_agent_id, 'club_id', v_club_id,
    'is_prepaid', CASE WHEN v_touches_funding THEN v_prepaid_after ELSE v_prepaid_now END,
    'credit_limit', CASE WHEN v_touches_funding THEN v_limit_after ELSE v_limit_now END);
EXCEPTION WHEN SQLSTATE 'PAG01' THEN
  -- This block rolls back the agent insert/update and every role-callee write.
  RETURN COALESCE(v_role_res,jsonb_build_object('success',false,'error','role change refused'));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_agent_downline_commission(p_club_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_id',  d.id,
           'user_id',   d.user_id,
           'club_id',   d.club_id,
           'unclaimed', COALESCE(t.unclaimed, 0))), '[]'::jsonb)
    INTO v_result
    FROM public.agents me
    JOIN public.agents d ON d.parent_agent_id = me.id AND d.club_id=me.club_id
    LEFT JOIN LATERAL (
           SELECT SUM(ac.amount) AS unclaimed
             FROM public.agent_commissions ac
            WHERE ac.club_id = d.club_id
              AND ac.user_id = d.user_id
              AND ac.settled_at IS NULL AND NOT public.fn_agent_commission_paid_by_period(ac.club_id, ac.user_id, ac.created_at)
         ) t ON TRUE
   WHERE me.user_id = v_uid
     AND (p_club_id IS NULL OR me.club_id = p_club_id);

  RETURN v_result;
END;
$function$;


COMMIT;
