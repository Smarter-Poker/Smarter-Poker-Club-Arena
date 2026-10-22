-- Version reserved by scripts/new-migration.mjs, 20261021183705.
-- Internal hierarchy predicates must not expose another actor's scope over RPC.
-- Caller-bound wrappers preserve the exact seven RLS expressions. Existing
-- SECURITY DEFINER transaction callers retain raw helper access unchanged.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
-- Admit every policy relation before catalog changes, child relations before roots.
LOCK TABLE public.chip_escrow,public.cashout_requests,public.chip_requests,
 public.tournament_ticket_entry_targets,public.tournament_tickets,public.agents,public.club_members
 IN ACCESS EXCLUSIVE MODE;
DO $preimages$ BEGIN
 IF md5(pg_get_functiondef('public.fn_club_bank_role(uuid,uuid)'::regprocedure)) IS DISTINCT FROM '36d48c9e935b77e4410075a482194dab' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_club_bank_role(uuid,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'PRIVATE_GRAPH_HELPER_PREIMAGE_CHANGED: fn_club_bank_role(uuid,uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_club_cashier_can_transact(uuid,uuid,uuid)'::regprocedure)) IS DISTINCT FROM 'a812c44870554f37cddb36edf600e386' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_club_cashier_can_transact(uuid,uuid,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'PRIVATE_GRAPH_HELPER_PREIMAGE_CHANGED: fn_club_cashier_can_transact(uuid,uuid,uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_club_cashier_scope(uuid,uuid)'::regprocedure)) IS DISTINCT FROM '166dddd19d1419cc8b17861003e0239a' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_club_cashier_scope(uuid,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'PRIVATE_GRAPH_HELPER_PREIMAGE_CHANGED: fn_club_cashier_scope(uuid,uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_club_is_in_downline(uuid,uuid,uuid)'::regprocedure)) IS DISTINCT FROM '35a7df4cfd5bce2d221ccb74058d4d92' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_club_is_in_downline(uuid,uuid,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'PRIVATE_GRAPH_HELPER_PREIMAGE_CHANGED: fn_club_is_in_downline(uuid,uuid,uuid)'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND NOT p.prosecdef AND p.prosrc ~ '(fn_club_is_in_downline|fn_club_cashier_scope|fn_club_cashier_can_transact|fn_club_bank_role)\(') THEN RAISE EXCEPTION 'PRIVATE_GRAPH_INVOKER_CALLER_REQUIRES_REVIEW'; END IF;
 IF EXISTS(SELECT 1 FROM pg_views WHERE schemaname='public' AND definition ~ '(fn_club_is_in_downline|fn_club_cashier_scope|fn_club_cashier_can_transact|fn_club_bank_role)\(') THEN RAISE EXCEPTION 'PRIVATE_GRAPH_VIEW_CALLER_REQUIRES_REVIEW'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND (qual ~ '(fn_club_is_in_downline|fn_club_cashier_scope|fn_club_cashier_can_transact|fn_club_bank_role)\(' OR with_check ~ '(fn_club_is_in_downline|fn_club_cashier_scope|fn_club_cashier_can_transact|fn_club_bank_role)\(')) <> 7 THEN RAISE EXCEPTION 'PRIVATE_GRAPH_POLICY_SET_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tournament_ticket_entry_targets' AND policyname='cashier_tournament_ticket_entry_targets_read' AND qual='((issued_by = ( SELECT auth.uid() AS uid)) OR (holder_id = ( SELECT auth.uid() AS uid)) OR (fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = ''all''::text))' AND with_check IS NULL AND cmd='SELECT' AND permissive='PERMISSIVE' AND roles=ARRAY['authenticated']::name[]) THEN RAISE EXCEPTION 'PRIVATE_GRAPH_POLICY_PREIMAGE_CHANGED: tournament_ticket_entry_targets.cashier_tournament_ticket_entry_targets_read'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='club_members' AND policyname='cashier_downline_read' AND qual='((fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = ''downline''::text) AND fn_club_cashier_can_transact(club_id, ( SELECT auth.uid() AS uid), user_id))' AND with_check IS NULL AND cmd='SELECT' AND permissive='PERMISSIVE' AND roles=ARRAY['authenticated']::name[]) THEN RAISE EXCEPTION 'PRIVATE_GRAPH_POLICY_PREIMAGE_CHANGED: club_members.cashier_downline_read'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='agents' AND policyname='agents_cashier_scoped_read' AND qual='((user_id = ( SELECT auth.uid() AS uid)) OR (fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = ''all''::text) OR ((fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = ''downline''::text) AND fn_club_cashier_can_transact(club_id, ( SELECT auth.uid() AS uid), user_id)))' AND with_check IS NULL AND cmd='SELECT' AND permissive='PERMISSIVE' AND roles=ARRAY['authenticated']::name[]) THEN RAISE EXCEPTION 'PRIVATE_GRAPH_POLICY_PREIMAGE_CHANGED: agents.agents_cashier_scoped_read'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tournament_tickets' AND policyname='cashier_tournament_tickets_read' AND qual='((issued_by = ( SELECT auth.uid() AS uid)) OR (holder_id = ( SELECT auth.uid() AS uid)) OR (fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = ''all''::text))' AND with_check IS NULL AND cmd='SELECT' AND permissive='PERMISSIVE' AND roles=ARRAY['authenticated']::name[]) THEN RAISE EXCEPTION 'PRIVATE_GRAPH_POLICY_PREIMAGE_CHANGED: tournament_tickets.cashier_tournament_tickets_read'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='chip_requests' AND policyname='cashier_chip_requests_read' AND qual='((requester_id = ( SELECT auth.uid() AS uid)) OR (approver_id = ( SELECT auth.uid() AS uid)) OR (fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = ''all''::text))' AND with_check IS NULL AND cmd='SELECT' AND permissive='PERMISSIVE' AND roles=ARRAY['authenticated']::name[]) THEN RAISE EXCEPTION 'PRIVATE_GRAPH_POLICY_PREIMAGE_CHANGED: chip_requests.cashier_chip_requests_read'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cashout_requests' AND policyname='cashout_read_scoped' AND qual='((player_id = ( SELECT auth.uid() AS uid)) OR (agent_id = ( SELECT auth.uid() AS uid)) OR (fn_club_bank_role(club_id) = ANY (ARRAY[''owner''::text, ''co_owner''::text, ''admin''::text])) OR fn_club_is_in_downline(club_id, ( SELECT auth.uid() AS uid), player_id))' AND with_check IS NULL AND cmd='SELECT' AND permissive='PERMISSIVE' AND roles=ARRAY['authenticated']::name[]) THEN RAISE EXCEPTION 'PRIVATE_GRAPH_POLICY_PREIMAGE_CHANGED: cashout_requests.cashout_read_scoped'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='chip_escrow' AND policyname='escrow_read_scoped' AND qual='((player_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM cashout_requests cr
  WHERE ((cr.id = chip_escrow.cashout_request_id) AND ((cr.agent_id = ( SELECT auth.uid() AS uid)) OR (fn_club_bank_role(cr.club_id) = ANY (ARRAY[''owner''::text, ''co_owner''::text, ''admin''::text])))))))' AND with_check IS NULL AND cmd='SELECT' AND permissive='PERMISSIVE' AND roles=ARRAY['authenticated']::name[]) THEN RAISE EXCEPTION 'PRIVATE_GRAPH_POLICY_PREIMAGE_CHANGED: chip_escrow.escrow_read_scoped'; END IF;
END $preimages$;
CREATE FUNCTION public.fn_club_viewer_cashier_scope(p_club_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN auth.uid() IS NULL THEN 'none' ELSE public.fn_club_cashier_scope(p_club_id,auth.uid()) END;
$$;
REVOKE ALL ON FUNCTION public.fn_club_viewer_cashier_scope(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_club_viewer_cashier_scope(uuid) TO authenticated,service_role;
CREATE FUNCTION public.fn_club_viewer_can_transact(p_club_id uuid,p_target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND public.fn_club_cashier_can_transact(p_club_id,auth.uid(),p_target);
$$;
REVOKE ALL ON FUNCTION public.fn_club_viewer_can_transact(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_club_viewer_can_transact(uuid,uuid) TO authenticated,service_role;
CREATE FUNCTION public.fn_club_viewer_is_in_downline(p_club_id uuid,p_target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND public.fn_club_is_in_downline(p_club_id,auth.uid(),p_target);
$$;
REVOKE ALL ON FUNCTION public.fn_club_viewer_is_in_downline(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_club_viewer_is_in_downline(uuid,uuid) TO authenticated,service_role;
CREATE FUNCTION public.fn_club_viewer_bank_role(p_club_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN auth.uid() IS NULL THEN NULL::text ELSE public.fn_club_bank_role(p_club_id,auth.uid()) END;
$$;
REVOKE ALL ON FUNCTION public.fn_club_viewer_bank_role(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_club_viewer_bank_role(uuid) TO authenticated,service_role;
ALTER POLICY "cashier_tournament_ticket_entry_targets_read" ON public."tournament_ticket_entry_targets" USING (((issued_by = ( SELECT auth.uid() AS uid)) OR (holder_id = ( SELECT auth.uid() AS uid)) OR (fn_club_viewer_cashier_scope(club_id) = 'all'::text)));
ALTER POLICY "cashier_downline_read" ON public."club_members" USING (((fn_club_viewer_cashier_scope(club_id) = 'downline'::text) AND fn_club_viewer_can_transact(club_id, user_id)));
ALTER POLICY "agents_cashier_scoped_read" ON public."agents" USING (((user_id = ( SELECT auth.uid() AS uid)) OR (fn_club_viewer_cashier_scope(club_id) = 'all'::text) OR ((fn_club_viewer_cashier_scope(club_id) = 'downline'::text) AND fn_club_viewer_can_transact(club_id, user_id))));
ALTER POLICY "cashier_tournament_tickets_read" ON public."tournament_tickets" USING (((issued_by = ( SELECT auth.uid() AS uid)) OR (holder_id = ( SELECT auth.uid() AS uid)) OR (fn_club_viewer_cashier_scope(club_id) = 'all'::text)));
ALTER POLICY "cashier_chip_requests_read" ON public."chip_requests" USING (((requester_id = ( SELECT auth.uid() AS uid)) OR (approver_id = ( SELECT auth.uid() AS uid)) OR (fn_club_viewer_cashier_scope(club_id) = 'all'::text)));
ALTER POLICY "cashout_read_scoped" ON public."cashout_requests" USING (((player_id = ( SELECT auth.uid() AS uid)) OR (agent_id = ( SELECT auth.uid() AS uid)) OR (fn_club_viewer_bank_role(club_id) = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text])) OR fn_club_viewer_is_in_downline(club_id, player_id)));
ALTER POLICY "escrow_read_scoped" ON public."chip_escrow" USING (((player_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM cashout_requests cr
  WHERE ((cr.id = chip_escrow.cashout_request_id) AND ((cr.agent_id = ( SELECT auth.uid() AS uid)) OR (fn_club_viewer_bank_role(cr.club_id) = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text]))))))));
REVOKE EXECUTE ON FUNCTION public.fn_club_bank_role(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_club_cashier_can_transact(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_club_cashier_scope(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_club_is_in_downline(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
-- Bind the one browser-callable actor-taking role helper to the real viewer.
DO $$ BEGIN
 IF md5(pg_get_functiondef('public.fn_club_grantable_roles(uuid,uuid,uuid)'::regprocedure)) IS DISTINCT FROM '58db7ff4dad0fef814aae1208ce78b96'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_club_grantable_roles(uuid,uuid,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
 RAISE EXCEPTION 'PRIVATE_GRAPH_GRANTABLE_PREIMAGE_CHANGED'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.fn_club_grantable_roles(p_club_id uuid, p_actor_user_id uuid, p_target_user_id uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor_role  text;
  v_target_role text;
  v_platform_admin boolean := false;
BEGIN
  -- A browser can establish only its own actor. Trusted service/management
  -- calls with no user JWT retain the existing actor-based business contract.
  IF auth.uid() IS NOT NULL AND p_actor_user_id IS DISTINCT FROM auth.uid() THEN RETURN '{}'; END IF;
  IF p_actor_user_id IS NULL OR p_target_user_id IS NULL THEN RETURN '{}'; END IF;

  -- Nobody edits their own title. An owner demoting themselves would leave a
  -- club with no owner; anyone else would simply be promoting themselves.
  IF p_actor_user_id = p_target_user_id THEN RETURN '{}'; END IF;

  SELECT role INTO v_actor_role FROM club_members
   WHERE club_id = p_club_id AND user_id = p_actor_user_id
     AND status IN ('active','approved');

  SELECT role INTO v_target_role FROM club_members
   WHERE club_id = p_club_id AND user_id = p_target_user_id
     AND status IN ('active','approved');

  IF v_target_role IS NULL THEN RETURN '{}'; END IF;

  SELECT COALESCE(is_admin, false) INTO v_platform_admin
    FROM profiles WHERE id = p_actor_user_id;

  IF v_actor_role IS NULL AND NOT v_platform_admin THEN RETURN '{}'; END IF;

  -- The club owner is not demotable through this path. Handing over a club is
  -- a deliberate act of its own, not a dropdown on the members list.
  IF v_target_role = 'owner' THEN RETURN '{}'; END IF;

  IF v_platform_admin OR v_actor_role = 'owner' THEN
    RETURN ARRAY['co_owner','admin','super_agent','agent','sub_agent','player'];
  END IF;

  IF v_actor_role IN ('co_owner','admin') THEN
    -- "as high as admin". A co-owner outranks an admin but may not appoint or
    -- remove another co-owner; only the owner does that.
    IF fn_club_role_rank(v_target_role) >= fn_club_role_rank(v_actor_role) THEN
      RETURN '{}';
    END IF;
    RETURN ARRAY['admin','super_agent','agent','sub_agent','player'];
  END IF;

  -- A super agent manages the whole ladder beneath it, inside its own
  -- downline: agent, sub agent, player -- in either direction. It may not
  -- mint another super agent; that is owner / co-owner / admin work.
  IF v_actor_role = 'super_agent' THEN
    IF v_target_role IN ('player','agent','sub_agent')
       AND fn_club_is_in_downline(p_club_id, p_actor_user_id, p_target_user_id) THEN
      RETURN ARRAY['agent','sub_agent','player'];
    END IF;
    RETURN '{}';
  END IF;

  -- An agent may raise a player of theirs to sub agent, and put them back.
  IF v_actor_role = 'agent' THEN
    IF v_target_role IN ('player','sub_agent')
       AND fn_club_is_in_downline(p_club_id, p_actor_user_id, p_target_user_id) THEN
      RETURN ARRAY['sub_agent','player'];
    END IF;
    RETURN '{}';
  END IF;

  -- sub agents and players promote nobody
  RETURN '{}';
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_club_grantable_roles(uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_club_grantable_roles(uuid,uuid,uuid) TO authenticated,service_role;
DO $$ BEGIN
 IF md5(pg_get_functiondef('public.ca_club_grantable_roles(uuid,uuid)'::regprocedure)) IS DISTINCT FROM 'd5f256cf7396f9758c956a824d608aa8'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.ca_club_grantable_roles(uuid,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
 RAISE EXCEPTION 'PRIVATE_GRAPH_ROLE_CHOOSER_PREIMAGE_CHANGED'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.ca_club_grantable_roles(p_club_id uuid, p_target_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_roles text[];
BEGIN
  -- Do not read or return an unrelated player's role through the chooser RPC.
  IF auth.uid() IS NOT NULL AND NOT COALESCE(public.fn_can_read_club_member_data(p_club_id,p_target_user_id),false) THEN
    RETURN jsonb_build_object('roles','[]'::jsonb,'target_role',NULL,'actor_role',NULL);
  END IF;
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('roles', '[]'::jsonb); END IF;
  v_roles := fn_club_grantable_roles(p_club_id, auth.uid(), p_target_user_id);
  RETURN jsonb_build_object(
    'roles', COALESCE(to_jsonb(v_roles), '[]'::jsonb),
    'target_role', (SELECT role FROM club_members
                     WHERE club_id = p_club_id AND user_id = p_target_user_id
                       AND status IN ('active','approved')),
    'actor_role', (SELECT role FROM club_members
                    WHERE club_id = p_club_id AND user_id = auth.uid()
                      AND status IN ('active','approved')));
END;
$function$
;
REVOKE ALL ON FUNCTION public.ca_club_grantable_roles(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_club_grantable_roles(uuid,uuid) TO authenticated,service_role;

COMMIT;
