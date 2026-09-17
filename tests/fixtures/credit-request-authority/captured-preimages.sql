-- Actual bounded catalog captures, no production rows. Load after full-weekly-accounting/schema.sql and access.sql, before candidate.sql.

CREATE TABLE public.credit_requests (

  id uuid DEFAULT gen_random_uuid() NOT NULL,
  requester_id uuid NOT NULL,
  approver_id uuid,
  club_id uuid NOT NULL,
  requested_amount numeric DEFAULT 0 NOT NULL,
  approved_amount numeric,
  reason text,
  status text DEFAULT 'pending'::text NOT NULL,
  reviewer_notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  reviewed_at timestamp with time zone,
  reviewed_by uuid,
  CONSTRAINT credit_requests_pkey PRIMARY KEY (id)

);

ALTER TABLE public.credit_requests OWNER TO postgres;

ALTER TABLE public.credit_requests ENABLE ROW LEVEL SECURITY;

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
    SELECT credit_limit INTO v_parent_limit FROM agents WHERE id = v_parent;
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
      RETURN v_role_res;
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
END;
$function$
;

ALTER FUNCTION public.fn_admin_update_agent(uuid,text,text,numeric,numeric,numeric,uuid,text,boolean) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_admin_update_agent(uuid,text,text,numeric,numeric,numeric,uuid,text,boolean) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_admin_update_agent(uuid,text,text,numeric,numeric,numeric,uuid,text,boolean) TO authenticated;

GRANT EXECUTE ON FUNCTION public.fn_admin_update_agent(uuid,text,text,numeric,numeric,numeric,uuid,text,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_notify_credit_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      PERFORM public.fn_raise_notification(
        NEW.approver_id, 'credit_request', 'Credit Request',
        public.fn_notify_display_name(NEW.requester_id)
          || ' requested ' || to_char(COALESCE(NEW.requested_amount, 0), 'FM999,999,999,990') || ' chips credit',
        '/agent/credit-requests',
        jsonb_build_object('creditRequestId', NEW.id, 'clubId', NEW.club_id));
    ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
      IF NEW.status = 'approved' THEN
        PERFORM public.fn_raise_notification(
          NEW.requester_id, 'credit_approved', 'Credit Line Increased',
          'Your credit line was raised to '
            || to_char(COALESCE(NEW.approved_amount, NEW.requested_amount, 0), 'FM999,999,999,990') || ' chips',
          '/wallet', jsonb_build_object('creditRequestId', NEW.id));
      ELSIF NEW.status = 'denied' THEN
        PERFORM public.fn_raise_notification(
          NEW.requester_id, 'credit_denied', 'Credit Request Denied',
          COALESCE(NULLIF(btrim(NEW.reviewer_notes), ''), 'Your credit request was not approved'),
          '/wallet', jsonb_build_object('creditRequestId', NEW.id));
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_notify_credit_request failed for request %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END; $function$
;

ALTER FUNCTION public.fn_notify_credit_request() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_notify_credit_request() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_notify_credit_request() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_notify_display_name(p_user_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
           NULLIF(public.fn_arena_name(p.alias, p.username, p.display_name,
                                       p.first_name, p.last_name, p.full_name),
                  'Player'),
           'Someone')
    FROM public.profiles p
   WHERE p.id = p_user_id;
$function$
;

ALTER FUNCTION public.fn_notify_display_name(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_notify_display_name(uuid) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_notify_display_name(uuid) TO service_role;

CREATE POLICY credit_requests_insert_own ON public.credit_requests AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((requester_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY credit_requests_select ON public.credit_requests AS PERMISSIVE FOR SELECT TO authenticated USING (((requester_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = credit_requests.club_id) AND (c.owner_id = ( SELECT auth.uid() AS uid))))) OR (EXISTS ( SELECT 1
   FROM club_members cm
  WHERE ((cm.club_id = credit_requests.club_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)) AND (cm.role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text])))))));

CREATE POLICY credit_requests_update_manager ON public.credit_requests AS PERMISSIVE FOR UPDATE TO authenticated USING (((EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = credit_requests.club_id) AND (c.owner_id = ( SELECT auth.uid() AS uid))))) OR (EXISTS ( SELECT 1
   FROM club_members cm
  WHERE ((cm.club_id = credit_requests.club_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)) AND (cm.role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text])))))));

CREATE POLICY union_overseer_read ON public.credit_requests AS PERMISSIVE FOR SELECT TO authenticated USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));

CREATE TRIGGER trg_notify_credit_request AFTER INSERT OR UPDATE OF status ON public.credit_requests FOR EACH ROW EXECUTE FUNCTION fn_notify_credit_request();

REVOKE ALL ON public.credit_requests FROM PUBLIC,anon,authenticated,service_role;

GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES,TRIGGER,MAINTAIN ON public.credit_requests TO anon,authenticated;

GRANT ALL ON public.credit_requests TO service_role;
