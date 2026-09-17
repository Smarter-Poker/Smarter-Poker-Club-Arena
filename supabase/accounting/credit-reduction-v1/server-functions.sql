-- SOURCE ONLY / UNRUN. One guarded transaction must also load root's document,
-- delivery and private-reader fragments. The sole funding writer stays
-- fn_admin_update_agent; these functions coordinate intent and retained proof.

CREATE FUNCTION public.fn_credit_reduction_lock_v1(p_actor uuid,p_operation uuid,p_club uuid) RETURNS void
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
  RAISE EXCEPTION 'credit_reduction_read_committed_required' USING ERRCODE='25000';END IF;
 IF p_actor IS NULL OR p_actor='00000000-0000-0000-0000-000000000000'::uuid OR auth.uid() IS DISTINCT FROM p_actor THEN
  RAISE EXCEPTION 'credit_reduction_actor_changed' USING ERRCODE='42501';END IF;
 IF p_operation IS NULL OR p_club IS NULL
  OR p_operation='00000000-0000-0000-0000-000000000000'::uuid OR p_club='00000000-0000-0000-0000-000000000000'::uuid THEN
  RAISE EXCEPTION 'credit_reduction_invalid_identity' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club::text,0));
 -- Global actor/operation identity also prevents reusing an operation in a
 -- different club. Existing operations are read only after both locks.
 PERFORM pg_advisory_xact_lock(hashtextextended('credit-reduction:'||p_actor::text||':'||p_operation::text,0));
END $function$;

-- New-change authority is held through the target-row wait and the entire
-- transaction. This is not consulted by historical own receipt/retirement.
CREATE FUNCTION public.fn_credit_reduction_lock_current_manager_v1(p_actor uuid,p_club uuid) RETURNS void
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE owner_id uuid;member public.club_members%ROWTYPE;
BEGIN
 IF p_actor IS NULL OR p_actor='00000000-0000-0000-0000-000000000000'::uuid OR auth.uid() IS DISTINCT FROM p_actor THEN
  RAISE EXCEPTION 'credit_reduction_actor_changed' USING ERRCODE='42501';END IF;
 -- Caller already holds the club agreement mutex. Every amended financial
 -- entrypoint acquires that mutex before clubs/member/agent row locks.
 SELECT c.owner_id INTO owner_id FROM public.clubs c WHERE c.id=p_club FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'credit_reduction_not_authorized' USING ERRCODE='42501';END IF;
 IF owner_id=p_actor THEN RETURN;END IF;
 SELECT * INTO member FROM public.club_members WHERE club_id=p_club AND user_id=p_actor FOR SHARE;
 IF NOT FOUND OR member.role NOT IN('owner','co_owner','admin') OR member.role IS NULL
  OR member.status NOT IN('active','approved') OR member.status IS NULL
  OR member.is_active IS DISTINCT FROM true OR member.membership_lifecycle_status IS DISTINCT FROM 'active' THEN
  RAISE EXCEPTION 'credit_reduction_not_authorized' USING ERRCODE='42501';END IF;
END $function$;

CREATE FUNCTION public.fn_credit_reduction_receipt_payload_v1(p_receipt_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE o public.accounting_credit_reduction_operations_v1%ROWTYPE;
BEGIN
 SELECT * INTO STRICT o FROM public.accounting_credit_reduction_operations_v1 WHERE id=p_receipt_id;
 RETURN jsonb_build_object('contract_version',1,'receipt_id',o.id,
  'actor_user_id',o.actor_user_id,'operation_id',o.operation_id,'club_id',o.club_id,
  'agent_id',o.agent_id,'target_user_id',o.target_user_id,'action',o.action,
  'requested_reduction',round(o.requested_reduction,2)::text,'reason',o.reason,'assignment_reason',o.assignment_reason,
  'before_limit',round(o.before_limit,2)::text,'after_limit',round(o.after_limit,2)::text,
  'credit_used',round(o.credit_used,2)::text,'before_prepaid',o.before_prepaid,'after_prepaid',o.after_prepaid,
  'before_revision',o.before_revision::text,'after_revision',o.after_revision::text,
  'applied_reduction',round(o.applied_reduction,2)::text,
  'assignment_id',o.assignment_id,'document_id',o.document_id,'invoice_id',o.invoice_id,
  'recorded_at',to_char(o.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'outcome',CASE WHEN o.applied_reduction>0 THEN 'applied' ELSE 'no_change' END,
  'payment_proven',false,'chip_movement_claimed',false,'amount_due_claimed',false);
END $function$;

CREATE FUNCTION public.fn_credit_reduction_retirement_payload_v1(p_retirement_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE r public.accounting_credit_reduction_retirements_v1%ROWTYPE;
BEGIN
 SELECT * INTO STRICT r FROM public.accounting_credit_reduction_retirements_v1 WHERE id=p_retirement_id;
 RETURN jsonb_build_object('contract_version',1,'retirement_id',r.id,
  'actor_user_id',r.actor_user_id,'operation_id',r.operation_id,'club_id',r.club_id,
  'state','retired','retired_at',to_char(r.retired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
END $function$;

-- Internal observation after the caller has acquired the club/operation locks.
-- No current agent, assignment or permission joins for an original own receipt.
CREATE FUNCTION public.fn_credit_reduction_observe_v1(p_actor uuid,p_operation uuid,p_club uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE o public.accounting_credit_reduction_operations_v1%ROWTYPE;
 r public.accounting_credit_reduction_retirements_v1%ROWTYPE;result jsonb;
BEGIN
 SELECT * INTO o FROM public.accounting_credit_reduction_operations_v1 WHERE actor_user_id=p_actor AND operation_id=p_operation;
 SELECT * INTO r FROM public.accounting_credit_reduction_retirements_v1 WHERE actor_user_id=p_actor AND operation_id=p_operation;
 IF o.id IS NOT NULL AND r.id IS NOT NULL THEN
  RAISE EXCEPTION 'credit_reduction_evidence_conflict' USING ERRCODE='23514';END IF;
 IF (o.id IS NOT NULL AND o.club_id IS DISTINCT FROM p_club)
  OR (r.id IS NOT NULL AND r.club_id IS DISTINCT FROM p_club) THEN
  RAISE EXCEPTION 'credit_reduction_operation_scope_conflict' USING ERRCODE='23514';END IF;
 result:=jsonb_build_object('contract_version',1,'actor_user_id',p_actor,'operation_id',p_operation,'club_id',p_club,
  'state','absent','replayed',false,'receipt',NULL,'retirement',NULL);
 IF o.id IS NOT NULL THEN
  PERFORM public.fn_accounting_credit_reduction_assert_document(o.id);
  RETURN result||jsonb_build_object('state','recorded','replayed',true,'receipt',public.fn_credit_reduction_receipt_payload_v1(o.id));
 ELSIF r.id IS NOT NULL THEN
  RETURN result||jsonb_build_object('state','retired','replayed',true,'retirement',public.fn_credit_reduction_retirement_payload_v1(r.id));
 END IF;
 RETURN result;
END $function$;

CREATE FUNCTION public.fn_agent_credit_reduction_snapshot_v1(p_expected_actor_id uuid,p_club_id uuid,p_target_user_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE a public.agents%ROWTYPE;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
  RAISE EXCEPTION 'credit_reduction_read_committed_required' USING ERRCODE='25000';END IF;
 IF p_expected_actor_id IS NULL OR p_expected_actor_id='00000000-0000-0000-0000-000000000000'::uuid
  OR auth.uid() IS DISTINCT FROM p_expected_actor_id THEN
  RAISE EXCEPTION 'credit_reduction_actor_changed' USING ERRCODE='42501';END IF;
 IF p_club_id IS NULL OR p_target_user_id IS NULL
  OR p_club_id='00000000-0000-0000-0000-000000000000'::uuid OR p_target_user_id='00000000-0000-0000-0000-000000000000'::uuid THEN
  RAISE EXCEPTION 'credit_reduction_invalid_identity' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
 PERFORM public.fn_credit_reduction_lock_current_manager_v1(p_expected_actor_id,p_club_id);
 SELECT * INTO STRICT a FROM public.agents WHERE club_id=p_club_id AND user_id=p_target_user_id FOR UPDATE;
 IF a.id='00000000-0000-0000-0000-000000000000'::uuid OR a.credit_limit::text IN('NaN','Infinity','-Infinity') OR a.credit_used::text IN('NaN','Infinity','-Infinity')
  OR a.credit_limit<0 OR a.credit_used<0 OR a.credit_used>a.credit_limit OR a.credit_control_revision<0
  OR a.is_prepaid IS DISTINCT FROM (a.credit_limit=0) THEN
  RAISE EXCEPTION 'credit_reduction_invalid_prior_state' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('contract_version',1,'actor_user_id',p_expected_actor_id,'club_id',p_club_id,
  'agent_id',a.id,'target_user_id',a.user_id,'credit_limit',round(a.credit_limit,2)::text,
  'credit_used',round(a.credit_used,2)::text,'is_prepaid',a.is_prepaid,'control_revision',a.credit_control_revision::text,
  'captured_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
END $function$;

CREATE FUNCTION public.fn_reduce_agent_credit_v1(
 p_expected_actor_id uuid,p_operation_id uuid,p_club_id uuid,p_agent_id uuid,p_target_user_id uuid,
 p_requested_reduction numeric,p_expected_credit_limit numeric,p_expected_credit_used numeric,
 p_expected_is_prepaid boolean,p_expected_revision bigint,p_reason text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE prior jsonb;o public.accounting_credit_reduction_operations_v1%ROWTYPE;
 retained public.accounting_credit_reduction_operations_v1%ROWTYPE;
 a public.agents%ROWTYPE;after_agent public.agents%ROWTYPE;assignment public.credit_assignments%ROWTYPE;
 writer jsonb;applied numeric;after_limit numeric;after_prepaid boolean;accepted_reason text;
BEGIN
 -- Validate raw numeric parameters BEFORE assignment to numeric(15,2) fields,
 -- whose typmod would otherwise silently round a malformed fractional cent.
 IF p_agent_id IS NULL OR p_target_user_id IS NULL
  OR p_agent_id='00000000-0000-0000-0000-000000000000'::uuid OR p_target_user_id='00000000-0000-0000-0000-000000000000'::uuid
  OR p_requested_reduction IS NULL
  OR p_requested_reduction::text IN('NaN','Infinity','-Infinity') OR p_requested_reduction<=0
  OR p_requested_reduction>1000000000 OR p_requested_reduction<>round(p_requested_reduction,2)
  OR p_expected_credit_limit IS NULL OR p_expected_credit_used IS NULL
  OR p_expected_credit_limit::text IN('NaN','Infinity','-Infinity') OR p_expected_credit_used::text IN('NaN','Infinity','-Infinity')
  OR p_expected_credit_limit<0 OR p_expected_credit_limit>9999999999999.99
  OR p_expected_credit_used<0 OR p_expected_credit_used>9999999999999.99
  OR p_expected_credit_limit<>round(p_expected_credit_limit,2) OR p_expected_credit_used<>round(p_expected_credit_used,2)
  OR p_expected_is_prepaid IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 THEN
  RAISE EXCEPTION 'credit_reduction_invalid_intent' USING ERRCODE='22023';END IF;
 PERFORM public.fn_credit_reduction_lock_v1(p_expected_actor_id,p_operation_id,p_club_id);
 prior:=public.fn_credit_reduction_observe_v1(p_expected_actor_id,p_operation_id,p_club_id);
 IF prior->>'state'='retired' THEN
  RAISE EXCEPTION 'credit_reduction_operation_retired' USING ERRCODE='23514';END IF;
 IF prior->>'state'='recorded' THEN
  SELECT * INTO STRICT o FROM public.accounting_credit_reduction_operations_v1
   WHERE actor_user_id=p_expected_actor_id AND operation_id=p_operation_id;
  IF o.agent_id IS DISTINCT FROM p_agent_id OR o.target_user_id IS DISTINCT FROM p_target_user_id
   OR o.requested_reduction IS DISTINCT FROM p_requested_reduction OR o.before_limit IS DISTINCT FROM p_expected_credit_limit
   OR o.credit_used IS DISTINCT FROM p_expected_credit_used OR o.before_prepaid IS DISTINCT FROM p_expected_is_prepaid
   OR o.before_revision IS DISTINCT FROM p_expected_revision OR o.reason IS DISTINCT FROM p_reason THEN
   RAISE EXCEPTION 'credit_reduction_operation_conflict' USING ERRCODE='23514';END IF;
  RETURN prior;
 END IF;
 IF prior->>'state' IS DISTINCT FROM 'absent' THEN
  RAISE EXCEPTION 'credit_reduction_evidence_conflict' USING ERRCODE='23514';END IF;
 PERFORM public.fn_credit_reduction_lock_current_manager_v1(p_expected_actor_id,p_club_id);
 SELECT * INTO a FROM public.agents WHERE id=p_agent_id AND club_id=p_club_id AND user_id=p_target_user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'credit_reduction_target_changed' USING ERRCODE='23514';END IF;
 IF a.id='00000000-0000-0000-0000-000000000000'::uuid OR a.credit_limit::text IN('NaN','Infinity','-Infinity') OR a.credit_used::text IN('NaN','Infinity','-Infinity')
  OR a.credit_limit<0 OR a.credit_used<0 OR a.credit_used>a.credit_limit
  OR a.is_prepaid IS DISTINCT FROM (a.credit_limit=0) THEN
  RAISE EXCEPTION 'credit_reduction_invalid_prior_state' USING ERRCODE='23514';END IF;
 IF a.credit_limit IS DISTINCT FROM p_expected_credit_limit OR a.credit_used IS DISTINCT FROM p_expected_credit_used
  OR a.is_prepaid IS DISTINCT FROM p_expected_is_prepaid OR a.credit_control_revision IS DISTINCT FROM p_expected_revision THEN
  RAISE EXCEPTION 'credit_reduction_state_changed' USING ERRCODE='23514';END IF;
 applied:=least(p_requested_reduction,a.credit_limit);after_limit:=a.credit_limit-applied;after_prepaid:=(after_limit=0);
 accepted_reason:=CASE WHEN p_reason IS NULL OR p_reason='' THEN 'Credit line reduced' ELSE p_reason END;
 after_agent:=a;
 IF applied>0 THEN
  IF a.credit_control_revision=9223372036854775807 THEN
   RAISE EXCEPTION 'credit_control_revision_exhausted' USING ERRCODE='22003';END IF;
  writer:=public.fn_admin_update_agent(p_agent_id=>a.id,p_credit_limit=>after_limit,
   p_assigned_by=>p_expected_actor_id,p_credit_reason=>accepted_reason,p_is_prepaid=>after_prepaid);
  IF jsonb_typeof(writer) IS DISTINCT FROM 'object' OR writer->'success' IS DISTINCT FROM 'true'::jsonb THEN
   -- Preserve the existing writer's debt/child-cap/funding refusal by rolling
   -- back this entire call; a refusal is never a retirement proof.
   RAISE EXCEPTION 'credit_reduction_writer_refused' USING ERRCODE='23514',DETAIL=COALESCE(writer->>'error','writer did not confirm');END IF;
  IF writer->>'agent_id' IS DISTINCT FROM a.id::text OR writer->>'club_id' IS DISTINCT FROM a.club_id::text
   OR writer->>'credit_assignment_id' IS NULL THEN
   RAISE EXCEPTION 'credit_reduction_writer_unconfirmed' USING ERRCODE='23514';END IF;
  SELECT * INTO after_agent FROM public.agents WHERE id=a.id;
  IF NOT FOUND OR after_agent.club_id IS DISTINCT FROM a.club_id OR after_agent.user_id IS DISTINCT FROM a.user_id
   OR after_agent.credit_limit IS DISTINCT FROM after_limit OR after_agent.credit_used IS DISTINCT FROM a.credit_used
   OR after_agent.is_prepaid IS DISTINCT FROM after_prepaid OR after_agent.credit_control_revision IS DISTINCT FROM a.credit_control_revision+1
   OR after_agent.status IS DISTINCT FROM a.status OR after_agent.role IS DISTINCT FROM a.role
   OR after_agent.parent_agent_id IS DISTINCT FROM a.parent_agent_id THEN
   RAISE EXCEPTION 'credit_reduction_writer_unconfirmed' USING ERRCODE='23514';END IF;
  SELECT * INTO assignment FROM public.credit_assignments WHERE id::text=writer->>'credit_assignment_id';
  IF NOT FOUND OR assignment.agent_id IS DISTINCT FROM a.id OR assignment.assigned_by IS DISTINCT FROM p_expected_actor_id
   OR assignment.old_limit IS DISTINCT FROM a.credit_limit OR assignment.new_limit IS DISTINCT FROM after_limit
   OR assignment.reason IS DISTINCT FROM accepted_reason OR assignment.created_at IS NULL OR NOT isfinite(assignment.created_at) THEN
   RAISE EXCEPTION 'credit_reduction_assignment_unconfirmed' USING ERRCODE='23514';END IF;
 END IF;
 o.id:=gen_random_uuid();o.contract_version:=1;o.actor_user_id:=p_expected_actor_id;o.operation_id:=p_operation_id;
 o.club_id:=p_club_id;o.agent_id:=a.id;o.target_user_id:=a.user_id;o.action:='reduce_credit_limit';
 o.requested_reduction:=p_requested_reduction;o.reason:=p_reason;o.assignment_reason:=accepted_reason;
 o.before_limit:=a.credit_limit;o.after_limit:=after_limit;o.credit_used:=a.credit_used;
 o.before_prepaid:=a.is_prepaid;o.after_prepaid:=after_prepaid;o.before_revision:=a.credit_control_revision;
 o.after_revision:=after_agent.credit_control_revision;o.applied_reduction:=applied;
 IF applied>0 THEN o.assignment_id:=assignment.id;o.document_id:=gen_random_uuid();o.invoice_id:=gen_random_uuid();END IF;
 o.recorded_at:=clock_timestamp();
 INSERT INTO public.accounting_credit_reduction_operations_v1 SELECT o.*;
 SELECT * INTO retained FROM public.accounting_credit_reduction_operations_v1 WHERE id=o.id;
 IF NOT FOUND OR to_jsonb(retained) IS DISTINCT FROM to_jsonb(o) THEN
  RAISE EXCEPTION 'credit_reduction_operation_write_unconfirmed' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_credit_reduction_retirements_v1
  WHERE actor_user_id=p_expected_actor_id AND operation_id=p_operation_id) THEN
  RAISE EXCEPTION 'credit_reduction_evidence_conflict' USING ERRCODE='23514';END IF;
 -- Document/notice construction can execute additional triggers. Their late
 -- effects are included in the fresh exact agent/audit postcondition.
 IF NOT EXISTS(SELECT 1 FROM public.agents x WHERE x.id=a.id AND to_jsonb(x)=to_jsonb(after_agent)) THEN
  RAISE EXCEPTION 'credit_reduction_agent_retained_mismatch' USING ERRCODE='23514';END IF;
 IF applied>0 AND NOT EXISTS(SELECT 1 FROM public.credit_assignments x WHERE x.id=assignment.id AND to_jsonb(x)=to_jsonb(assignment)) THEN
  RAISE EXCEPTION 'credit_reduction_assignment_retained_mismatch' USING ERRCODE='23514';END IF;
 PERFORM public.fn_accounting_credit_reduction_assert_document(o.id);
 -- The retained locks prevent concurrent authority changes; this readback
 -- also refuses an authority change made by a nested trigger in this call.
 PERFORM public.fn_credit_reduction_lock_current_manager_v1(p_expected_actor_id,p_club_id);
 RETURN jsonb_build_object('contract_version',1,'state','recorded','actor_user_id',p_expected_actor_id,
  'operation_id',p_operation_id,'club_id',p_club_id,'replayed',false,
  'receipt',public.fn_credit_reduction_receipt_payload_v1(o.id),'retirement',NULL);
END $function$;

CREATE FUNCTION public.fn_agent_credit_reduction_receipt_v1(p_expected_actor_id uuid,p_operation_id uuid,p_club_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
BEGIN
 PERFORM public.fn_credit_reduction_lock_v1(p_expected_actor_id,p_operation_id,p_club_id);
 RETURN public.fn_credit_reduction_observe_v1(p_expected_actor_id,p_operation_id,p_club_id);
END $function$;

CREATE FUNCTION public.fn_retire_agent_credit_reduction_v1(p_expected_actor_id uuid,p_operation_id uuid,p_club_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE prior jsonb;r public.accounting_credit_reduction_retirements_v1%ROWTYPE;
 surviving public.accounting_credit_reduction_retirements_v1%ROWTYPE;
BEGIN
 PERFORM public.fn_credit_reduction_lock_v1(p_expected_actor_id,p_operation_id,p_club_id);
 prior:=public.fn_credit_reduction_observe_v1(p_expected_actor_id,p_operation_id,p_club_id);
 IF prior->>'state' IN('recorded','retired') THEN RETURN prior;END IF;
 IF prior->>'state' IS DISTINCT FROM 'absent' THEN
  RAISE EXCEPTION 'credit_reduction_evidence_conflict' USING ERRCODE='23514';END IF;
 r.id:=gen_random_uuid();r.contract_version:=1;r.actor_user_id:=p_expected_actor_id;
 r.operation_id:=p_operation_id;r.club_id:=p_club_id;r.retired_at:=clock_timestamp();
 INSERT INTO public.accounting_credit_reduction_retirements_v1 SELECT r.*;
 SELECT * INTO surviving FROM public.accounting_credit_reduction_retirements_v1 WHERE id=r.id;
 IF NOT FOUND OR to_jsonb(surviving) IS DISTINCT FROM to_jsonb(r) THEN
  RAISE EXCEPTION 'credit_reduction_retirement_write_unconfirmed' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_credit_reduction_operations_v1
  WHERE actor_user_id=p_expected_actor_id AND operation_id=p_operation_id) THEN
  RAISE EXCEPTION 'credit_reduction_evidence_conflict' USING ERRCODE='23514';END IF;
 RETURN prior||jsonb_build_object('state','retired','replayed',false,'retirement',public.fn_credit_reduction_retirement_payload_v1(r.id));
END $function$;

ALTER FUNCTION public.fn_credit_reduction_lock_v1(uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_credit_reduction_lock_current_manager_v1(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_credit_reduction_receipt_payload_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_credit_reduction_retirement_payload_v1(uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_credit_reduction_observe_v1(uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_agent_credit_reduction_snapshot_v1(uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_reduce_agent_credit_v1(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,boolean,bigint,text) OWNER TO postgres;
ALTER FUNCTION public.fn_agent_credit_reduction_receipt_v1(uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_retire_agent_credit_reduction_v1(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_credit_reduction_lock_v1(uuid,uuid,uuid),
 public.fn_credit_reduction_lock_current_manager_v1(uuid,uuid),
 public.fn_credit_reduction_receipt_payload_v1(uuid),public.fn_credit_reduction_retirement_payload_v1(uuid),
 public.fn_credit_reduction_observe_v1(uuid,uuid,uuid),
 public.fn_agent_credit_reduction_snapshot_v1(uuid,uuid,uuid),
 public.fn_reduce_agent_credit_v1(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,boolean,bigint,text),
 public.fn_agent_credit_reduction_receipt_v1(uuid,uuid,uuid),public.fn_retire_agent_credit_reduction_v1(uuid,uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_agent_credit_reduction_snapshot_v1(uuid,uuid,uuid),
 public.fn_reduce_agent_credit_v1(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,boolean,bigint,text),
 public.fn_agent_credit_reduction_receipt_v1(uuid,uuid,uuid),public.fn_retire_agent_credit_reduction_v1(uuid,uuid,uuid)
 TO authenticated;
