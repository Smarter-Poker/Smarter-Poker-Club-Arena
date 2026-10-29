-- Remove the unused provider HTTP extension before enabling a LISTEN-only role.
-- Supabase documents DROP EXTENSION as the supported way to remove pg_net's
-- unavoidable PUBLIC queue writes. No GRANT/REVOKE, CASCADE or transport switch.
-- Refuse queued responses/requests, consumers, extension drift, live listener,
-- freeze, or replay. Recreate only through a separately qualified rollback if a
-- future product needs HTTP webhooks; this migration never recreates the grants.
-- https://supabase.com/kb/troubleshooting/revoking-access-to-pg_net-objects-has-no-effect
-- @live-proof: (NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_net') AND (SELECT supabase_enabled FROM public.ca_private_record_transport_state WHERE singleton) AND NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname='ca_record_gateway') AND public.fn_private_record_transport_ready())
BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='5s';
DO $remove$
DECLARE
 extension_id oid; members_hash text; member_count integer;
 prior_state jsonb; final_state jsonb;
BEGIN
 SELECT oid INTO extension_id FROM pg_catalog.pg_extension
 WHERE extname='pg_net' AND extversion='0.19.5'
   AND extowner='supabase_admin'::regrole;
 IF extension_id IS NULL THEN
  RAISE EXCEPTION 'PRIVATE_LISTENER_NET_EXTENSION_DRIFT_OR_REPLAY' USING ERRCODE='55000';
 END IF;
 SELECT count(*),md5(string_agg(pg_catalog.pg_describe_object(classid,objid,objsubid),E'\n'
   ORDER BY pg_catalog.pg_describe_object(classid,objid,objsubid) COLLATE "C"))
 INTO member_count,members_hash FROM pg_catalog.pg_depend
 WHERE refclassid='pg_catalog.pg_extension'::regclass AND refobjid=extension_id AND deptype='e';
 IF member_count<>28 OR members_hash IS DISTINCT FROM '9ef501c82bdd5516123287654d419c00' THEN
  RAISE EXCEPTION 'PRIVATE_LISTENER_NET_MEMBERS_CHANGED' USING ERRCODE='55000';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='ca_record_gateway'
   AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb
   AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit AND rolconnlimit=4
   AND shobj_description(oid,'pg_authid')='ca-private-record-listener:v1:disabled:20261028154533')
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usename='ca_record_gateway')
   OR public.fn_platform_frozen() OR NOT public.fn_private_record_transport_ready() THEN
  RAISE EXCEPTION 'PRIVATE_LISTENER_NET_RUNTIME_NOT_IDLE' USING ERRCODE='55000';
 END IF;
 SELECT to_jsonb(s) INTO prior_state FROM public.ca_private_record_transport_state s WHERE singleton;
 IF prior_state IS NULL OR prior_state->>'supabase_enabled' IS DISTINCT FROM 'true' THEN
  RAISE EXCEPTION 'PRIVATE_LISTENER_NET_PAID_TRANSPORT_REQUIRED' USING ERRCODE='55000';
 END IF;
 -- Serialize against a request appearing between the empty check and DROP.
 -- These are idle extension tables, never hot application or financial tables.
 LOCK TABLE net.http_request_queue,net._http_response IN ACCESS EXCLUSIVE MODE NOWAIT;
 IF EXISTS(SELECT 1 FROM net.http_request_queue) OR EXISTS(SELECT 1 FROM net._http_response) THEN
  RAISE EXCEPTION 'PRIVATE_LISTENER_NET_PENDING_REQUEST_OR_RESPONSE' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
   JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE NOT t.tgisinternal
   AND (n.nspname='net' OR (n.nspname='supabase_functions' AND p.proname='http_request')))
   OR EXISTS(SELECT 1 FROM cron.job WHERE command ~* '(net[[:space:]]*[.]|"net"[[:space:]]*[.]|http_request|http_post|http_get)')
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
     WHERE p.prokind IN ('f','p') AND n.nspname NOT IN ('net','pg_catalog','information_schema')
       AND NOT (n.nspname='extensions' AND p.proname='grant_pg_net_access'
         AND md5(pg_catalog.pg_get_functiondef(p.oid))='1d06ef4fb47bb0ab6e6f8818a62013bb')
       AND p.prosrc ~* '(net[[:space:]]*[.]|"net"[[:space:]]*[.])[[:space:]]*"?[_a-z][_a-z0-9]*"?[[:space:]]*[(]') THEN
  RAISE EXCEPTION 'PRIVATE_LISTENER_NET_CONSUMER_FOUND' USING ERRCODE='55000';
 END IF;
 -- RESTRICT is deliberate: any unanticipated external catalog dependency aborts
 -- the complete transaction. Never remove application objects with CASCADE.
 DROP EXTENSION pg_net RESTRICT;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_extension WHERE extname='pg_net')
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='net') THEN
  RAISE EXCEPTION 'PRIVATE_LISTENER_NET_REMOVAL_INCOMPLETE' USING ERRCODE='55000';
 END IF;
 SELECT to_jsonb(s) INTO final_state FROM public.ca_private_record_transport_state s WHERE singleton;
 IF final_state IS DISTINCT FROM prior_state OR NOT public.fn_private_record_transport_ready()
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='ca_record_gateway' AND rolcanlogin) THEN
  RAISE EXCEPTION 'PRIVATE_LISTENER_NET_TRANSPORT_CHANGED' USING ERRCODE='55000';
 END IF;
END $remove$;
COMMIT;
