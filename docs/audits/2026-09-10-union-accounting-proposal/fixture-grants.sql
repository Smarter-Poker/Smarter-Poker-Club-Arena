REVOKE ALL ON FUNCTION public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid) TO service_role,authenticated;
DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_resolve_player_club_for_agent(uuid,uuid,uuid)'::regprocedure)<>'a05131eb6fff1c2438cb7d24eb2eac1b' THEN RAISE EXCEPTION 'Resolver fixture differs from captured production'; END IF;
END $$;
