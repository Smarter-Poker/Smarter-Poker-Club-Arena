-- Reserved by scripts/new-migration.mjs. Database-only; no engine replacement.
-- Live service calls hit permission denied for lightning_top_up_intents on
-- terminal instance updates. The trigger was INVOKER while its original
-- top-up state is deliberately private. Keep the private table/finisher ACLs
-- and every original reservation, blind, funding and cancellation statement.
-- Only this existing trigger executes as its pinned postgres owner.
-- @live-proof: (SELECT prosecdef AND md5(pg_get_functiondef(oid))='6c5e5a119c75dd4cc6c69c6ae84ec376' FROM pg_proc WHERE oid='public.fn_lightning_instance_releases_its_reservations()'::regprocedure)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $authority$
DECLARE
 target regprocedure:='public.fn_lightning_instance_releases_its_reservations()'::regprocedure;
 before_text text; prior_acl aclitem[];
BEGIN
 SELECT pg_get_functiondef(oid),proacl INTO before_text,prior_acl FROM pg_proc WHERE oid=target;
 IF md5(before_text) IS DISTINCT FROM 'e5e8fedfc73394c7c182a44e813d5f20'
 OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR prosecdef OR prorettype<>'trigger'::regtype FROM pg_proc WHERE oid=target)
 OR has_function_privilege('anon',target,'EXECUTE')
 OR has_function_privilege('authenticated',target,'EXECUTE') THEN
  RAISE EXCEPTION 'Lightning terminal trigger authority preimage changed';
 END IF;
 ALTER FUNCTION public.fn_lightning_instance_releases_its_reservations() SECURITY DEFINER;
 IF pg_get_functiondef(target) IS DISTINCT FROM replace(before_text,E' LANGUAGE plpgsql\n',E' LANGUAGE plpgsql\n SECURITY DEFINER\n')
 OR (SELECT proacl FROM pg_proc WHERE oid=target) IS DISTINCT FROM prior_acl
 OR has_table_privilege('service_role','smarter_private.lightning_top_up_intents','SELECT')
 OR has_table_privilege('service_role','smarter_private.lightning_top_up_intents','UPDATE') THEN
  RAISE EXCEPTION 'Lightning terminal trigger body or private boundary changed';
 END IF;
END $authority$;
COMMIT;
