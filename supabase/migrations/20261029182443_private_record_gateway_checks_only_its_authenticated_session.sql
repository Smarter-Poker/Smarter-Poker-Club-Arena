-- Gateway-only read capabilities replace its process-wide service-role key.
-- Existing engine clients, session semantics, topic ACLs and transport flags stay unchanged.
-- Version reserved by scripts/new-migration.mjs.
-- @live-proof: (SELECT to_regprocedure('public.fn_ca_private_record_gateway_session_live()') IS NOT NULL AND to_regprocedure('public.fn_ca_private_record_gateway_ready()') IS NOT NULL)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $guard$
BEGIN
 IF to_regprocedure('public.fn_ca_private_record_gateway_session_live()') IS NOT NULL
 OR to_regprocedure('public.fn_ca_private_record_gateway_ready()') IS NOT NULL THEN
   RAISE EXCEPTION 'PRIVATE_RECORD_GATEWAY_ACCESS_ALREADY_EXISTS';
 END IF;
 IF md5(pg_get_functiondef('public.fn_ca_player_session_live(uuid,uuid)'::regprocedure))
      IS DISTINCT FROM 'f91ab698ccdeff0e5465cb661cf1a547'
 OR md5(pg_get_functiondef('public.fn_private_record_transport_ready()'::regprocedure))
      IS DISTINCT FROM '07c92fe5dc7018f15a23d34f9bb2b386'
 OR EXISTS(SELECT 1 FROM pg_proc WHERE oid IN (
      'public.fn_ca_player_session_live(uuid,uuid)'::regprocedure,
      'public.fn_private_record_transport_ready()'::regprocedure)
      AND (proowner<>'postgres'::regrole OR NOT prosecdef)) THEN
   RAISE EXCEPTION 'PRIVATE_RECORD_GATEWAY_ACCESS_PREIMAGE_CHANGED';
 END IF;
END $guard$;
CREATE FUNCTION public.fn_ca_private_record_gateway_session_live() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,auth,public AS $$
DECLARE actor uuid:=auth.uid(); sid text:=auth.jwt()->>'session_id'; session_id uuid;
BEGIN
 IF actor IS NULL THEN RETURN false; END IF;
 -- Match the engine's tokenSessionId parser and authoritative legacy semantics.
 -- No caller-supplied user/session IDs are accepted or returned.
 IF sid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
   session_id:=sid::uuid;
 END IF;
 RETURN public.fn_ca_player_session_live(actor,session_id);
END $$;
ALTER FUNCTION public.fn_ca_private_record_gateway_session_live() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_private_record_gateway_session_live() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_private_record_gateway_session_live() TO authenticated;
CREATE FUNCTION public.fn_ca_private_record_gateway_ready() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.fn_private_record_transport_ready();
$$;
ALTER FUNCTION public.fn_ca_private_record_gateway_ready() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_private_record_gateway_ready() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_private_record_gateway_ready() TO anon,authenticated;
COMMIT;
