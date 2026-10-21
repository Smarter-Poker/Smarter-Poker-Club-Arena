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
COMMIT;
