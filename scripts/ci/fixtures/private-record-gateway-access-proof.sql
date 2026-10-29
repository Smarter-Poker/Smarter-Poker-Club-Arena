-- Real source helpers loaded from maintained files; the new migration's exact
-- production preimage checks executed without fixture substitutions/bypasses.
INSERT INTO public.ca_player_session_revocations(user_id,revoked_before,op_id)
VALUES ('82000000-0000-0000-0000-000000000002',now(),'fixture');
INSERT INTO auth.sessions(id,user_id,not_after) VALUES
('82000000-0000-0000-0000-000000000011','82000000-0000-0000-0000-000000000001',NULL),
('82000000-0000-0000-0000-000000000012','82000000-0000-0000-0000-000000000002',now()+interval '1 hour'),
('82000000-0000-0000-0000-000000000013','82000000-0000-0000-0000-000000000002',now()-interval '1 hour');
DO $$
DECLARE fn regprocedure; role_name text;
BEGIN
 FOREACH fn IN ARRAY ARRAY['public.fn_ca_private_record_gateway_session_live()'::regprocedure,'public.fn_ca_private_record_gateway_ready()'::regprocedure] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=fn AND proowner='postgres'::regrole AND prosecdef AND provolatile='s') THEN RAISE EXCEPTION 'gateway function authority changed'; END IF;
 END LOOP;
 IF has_function_privilege('anon','public.fn_ca_private_record_gateway_session_live()','EXECUTE')
 OR NOT has_function_privilege('authenticated','public.fn_ca_private_record_gateway_session_live()','EXECUTE')
 OR has_function_privilege('authenticated','public.fn_ca_player_session_live(uuid,uuid)','EXECUTE')
 OR has_function_privilege('anon','public.fn_private_record_transport_ready()','EXECUTE')
 OR NOT has_function_privilege('anon','public.fn_ca_private_record_gateway_ready()','EXECUTE') THEN RAISE EXCEPTION 'gateway function ACL changed'; END IF;
END $$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','82000000-0000-0000-0000-000000000002',false);
DO $$
BEGIN
 -- Own active session, then foreign, expired and absent sessions.
 PERFORM set_config('request.jwt.claims','{"session_id":"82000000-0000-0000-0000-000000000012"}',false);
 IF NOT public.fn_ca_private_record_gateway_session_live() THEN RAISE EXCEPTION 'own active session denied'; END IF;
 PERFORM set_config('request.jwt.claims','{"session_id":"82000000-0000-0000-0000-000000000011"}',false);
 IF public.fn_ca_private_record_gateway_session_live() THEN RAISE EXCEPTION 'foreign session admitted'; END IF;
 PERFORM set_config('request.jwt.claims','{"session_id":"82000000-0000-0000-0000-000000000013"}',false);
 IF public.fn_ca_private_record_gateway_session_live() THEN RAISE EXCEPTION 'expired session admitted'; END IF;
 PERFORM set_config('request.jwt.claims','{}',false);
 IF public.fn_ca_private_record_gateway_session_live() THEN RAISE EXCEPTION 'revoked missing session admitted'; END IF;
 PERFORM set_config('request.jwt.claims','{"session_id":"malformed"}',false);
 IF public.fn_ca_private_record_gateway_session_live() THEN RAISE EXCEPTION 'revoked malformed session admitted'; END IF;
 -- Match existing engine semantics for accounts without a revocation record.
 PERFORM set_config('request.jwt.claim.sub','82000000-0000-0000-0000-000000000001',false);
 IF NOT public.fn_ca_private_record_gateway_session_live() THEN RAISE EXCEPTION 'authoritative legacy semantics changed'; END IF;
 PERFORM set_config('request.jwt.claim.sub','',false);
 IF public.fn_ca_private_record_gateway_session_live() THEN RAISE EXCEPTION 'missing actor admitted'; END IF;
END $$;
RESET ROLE;
-- A formerly accepted session is revoked by removing that exact auth session,
-- matching the existing authoritative helper, without inventing timestamp rules.
DELETE FROM auth.sessions WHERE id='82000000-0000-0000-0000-000000000012';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','82000000-0000-0000-0000-000000000002',false);
SELECT set_config('request.jwt.claims','{"session_id":"82000000-0000-0000-0000-000000000012"}',false);
DO $$ BEGIN IF public.fn_ca_private_record_gateway_session_live() THEN RAISE EXCEPTION 'removed existing session still admitted'; END IF; END $$;
RESET ROLE;
SET ROLE anon;
DO $$
BEGIN
 BEGIN
  PERFORM public.fn_ca_private_record_gateway_session_live();
  RAISE EXCEPTION 'anonymous session check executed';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM singleton FROM public.ca_private_record_transport_state;
  RAISE EXCEPTION 'anonymous source details exposed';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 IF NOT public.fn_ca_private_record_gateway_ready() THEN RAISE EXCEPTION 'ready source denied'; END IF;
END $$;
RESET ROLE;
UPDATE public.ca_private_record_transport_state SET source_fingerprints=jsonb_set(source_fingerprints,'{public.gateway_source_one()}',to_jsonb(repeat('0',32)));
SET ROLE anon;
DO $$ BEGIN IF public.fn_ca_private_record_gateway_ready() THEN RAISE EXCEPTION 'source drift admitted'; END IF; END $$;
RESET ROLE;
DO $$ BEGIN IF NOT (SELECT supabase_enabled FROM public.ca_private_record_transport_state WHERE singleton) THEN RAISE EXCEPTION 'paid source changed'; END IF; END $$;
