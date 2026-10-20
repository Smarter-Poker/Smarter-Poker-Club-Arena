-- Additive, compatible assignment transaction for the client-first release.
-- No bank, private-column or reporting permission is revoked here.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
-- One club-scoped authority for hierarchy management. Being an agent alone
-- never grants the right to take another branch's members.
CREATE OR REPLACE FUNCTION public.fn_can_manage_club_assignments(p_club_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND (
   public.fn_club_bank_role(p_club_id) IN ('owner','co_owner','admin')
   OR (public.fn_is_any_union_overseer(auth.uid())
       AND public.fn_union_oversees_club(p_club_id,auth.uid())
       AND NOT EXISTS (SELECT 1 FROM public.club_members m WHERE m.club_id=p_club_id
         AND m.user_id=auth.uid() AND m.role IN ('super_agent','agent','sub_agent'))));
$$;
REVOKE ALL ON FUNCTION public.fn_can_manage_club_assignments(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_can_manage_club_assignments(uuid) TO authenticated,service_role;

CREATE TABLE IF NOT EXISTS public.club_assignment_operations (
 id uuid PRIMARY KEY, club_id uuid NOT NULL, actor_id uuid NOT NULL,
 destination_user_id uuid NOT NULL, source_user_id uuid,
 member_user_ids uuid[] NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.club_assignment_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_assignment_operations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.club_assignment_operations TO service_role;

CREATE OR REPLACE FUNCTION public.fn_reassign_club_members(
 p_club_id uuid,p_member_user_ids uuid[],p_agent_user_id uuid,p_op_id uuid,
 p_expected_agent_user_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_ids uuid[]; v_old record; v_parent uuid; v_rank integer; v_m record; v_count integer;
BEGIN
 IF NOT COALESCE(public.fn_can_manage_club_assignments(p_club_id),false) THEN
  RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501'; END IF;
 IF p_op_id IS NULL OR p_agent_user_id IS NULL OR p_club_id IS NULL THEN
  RAISE EXCEPTION 'assignment_identity_required' USING ERRCODE='22023'; END IF;
 v_ids:=ARRAY(SELECT DISTINCT x FROM unnest(p_member_user_ids) x WHERE x IS NOT NULL ORDER BY x);
 IF cardinality(v_ids)=0 OR cardinality(v_ids)>10000 THEN
  RAISE EXCEPTION 'select_between_1_and_10000_members' USING ERRCODE='22023'; END IF;
 -- Same agreement lock as role/rate changes, before any row locks.
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
 SELECT * INTO v_old FROM public.club_assignment_operations WHERE id=p_op_id;
 IF FOUND THEN
  IF v_old.club_id<>p_club_id OR v_old.actor_id<>auth.uid()
    OR v_old.destination_user_id<>p_agent_user_id OR v_old.member_user_ids<>v_ids
    OR v_old.source_user_id IS DISTINCT FROM p_expected_agent_user_id THEN
   RAISE EXCEPTION 'assignment_operation_conflict' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('success',true,'replayed',true,'operation_id',p_op_id,'moved',cardinality(v_ids));
 END IF;
 SELECT a.id,public.fn_club_role_rank(m.role) INTO v_parent,v_rank
 FROM public.agents a JOIN public.club_members m ON m.club_id=a.club_id AND m.user_id=a.user_id
 WHERE a.club_id=p_club_id AND a.user_id=p_agent_user_id AND a.status='active'
 AND m.role IN ('owner','co_owner','admin','super_agent','agent','sub_agent')
 AND public.fn_cashier_member_is_active(m.club_id,m.user_id) FOR UPDATE OF a,m;
 IF v_parent IS NULL THEN RAISE EXCEPTION 'agent_not_active_in_club' USING ERRCODE='22023'; END IF;
 IF p_agent_user_id=ANY(v_ids) THEN RAISE EXCEPTION 'agent_cannot_report_to_itself' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_count FROM public.club_members m WHERE m.club_id=p_club_id
  AND m.user_id=ANY(v_ids) AND public.fn_cashier_member_is_active(m.club_id,m.user_id);
 IF v_count<>cardinality(v_ids) THEN RAISE EXCEPTION 'member_not_active_in_club' USING ERRCODE='22023'; END IF;
 FOR v_m IN SELECT * FROM public.club_members m WHERE m.club_id=p_club_id AND m.user_id=ANY(v_ids)
  ORDER BY m.user_id FOR UPDATE LOOP
  IF v_m.role NOT IN ('member','player','super_agent','agent','sub_agent') THEN
   RAISE EXCEPTION 'staff_cannot_be_assigned_as_downline' USING ERRCODE='22023'; END IF;
  IF p_expected_agent_user_id IS NOT NULL AND v_m.agent_id IS DISTINCT FROM p_expected_agent_user_id THEN
   RAISE EXCEPTION 'assignment_changed_reload_members' USING ERRCODE='P0001'; END IF;
  IF public.fn_club_is_in_downline(p_club_id,v_m.user_id,p_agent_user_id) THEN
   RAISE EXCEPTION 'would_create_cycle' USING ERRCODE='22023'; END IF;
  IF v_m.role IN ('super_agent','agent','sub_agent')
     AND public.fn_club_role_rank(v_m.role)>=v_rank THEN
   RAISE EXCEPTION 'upline_role_must_rank_above_downline' USING ERRCODE='22023'; END IF;
 END LOOP;
 UPDATE public.club_members SET agent_id=p_agent_user_id,updated_at=now()
 WHERE club_id=p_club_id AND user_id=ANY(v_ids);
 -- Both maintained hierarchy representations change in the same transaction.
 UPDATE public.agents SET parent_agent_id=v_parent,updated_at=now()
 WHERE club_id=p_club_id AND user_id=ANY(v_ids);
 UPDATE public.agents a SET total_players=(SELECT count(*) FROM public.club_members m
   WHERE m.club_id=p_club_id AND m.agent_id=a.user_id),updated_at=now() WHERE a.club_id=p_club_id;
 INSERT INTO public.club_assignment_operations(id,club_id,actor_id,destination_user_id,source_user_id,member_user_ids)
 VALUES(p_op_id,p_club_id,auth.uid(),p_agent_user_id,p_expected_agent_user_id,v_ids);
 INSERT INTO public.audit_trail(actor_id,actor_role,action,target_type,target_id,reason)
 VALUES(auth.uid(),COALESCE(public.fn_club_bank_role(p_club_id),'union_overseer'),
  'reassign_club_downline','club',p_club_id,jsonb_build_object('operation_id',p_op_id,
  'destination',p_agent_user_id,'source',p_expected_agent_user_id,'members',v_ids)::text);
 RETURN jsonb_build_object('success',true,'operation_id',p_op_id,'moved',cardinality(v_ids));
END $$;
REVOKE ALL ON FUNCTION public.fn_reassign_club_members(uuid,uuid[],uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_reassign_club_members(uuid,uuid[],uuid,uuid,uuid) TO authenticated,service_role;

COMMIT;
