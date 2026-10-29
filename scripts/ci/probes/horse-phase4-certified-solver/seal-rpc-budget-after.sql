\set ON_ERROR_STOP on
DO $probe$
DECLARE p record; b record;
BEGIN
 SELECT * INTO STRICT b FROM v31_seal_rpc_before;
 SELECT * INTO STRICT p FROM pg_proc WHERE oid=b.oid;
 IF p.prosrc IS DISTINCT FROM b.prosrc OR p.proowner<>b.proowner
 OR p.proacl IS DISTINCT FROM b.proacl OR p.prosecdef<>b.prosecdef
 OR p.prorettype<>b.prorettype OR p.proargtypes<>b.proargtypes
 OR p.provolatile<>b.provolatile OR p.proparallel<>b.proparallel
 OR p.proleakproof<>b.proleakproof
 OR p.proconfig IS DISTINCT FROM b.proconfig||ARRAY['statement_timeout=240s','lock_timeout=1s']::text[]
 THEN RAISE EXCEPTION 'V31 seal RPC changed body, privileges or non-budget metadata'; END IF;
 IF EXISTS ((SELECT rolname,rolconfig FROM pg_roles WHERE rolname IN ('service_role','anon','authenticated')
 EXCEPT SELECT * FROM v31_seal_rpc_roles_before) UNION ALL
 (SELECT * FROM v31_seal_rpc_roles_before EXCEPT
 SELECT rolname,rolconfig FROM pg_roles WHERE rolname IN ('service_role','anon','authenticated')))
 OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role' AND 'statement_timeout=8s'=ANY(rolconfig))
 THEN RAISE EXCEPTION 'V31 seal RPC changed generic role budgets'; END IF;
 IF pg_get_functiondef('public.fn_gto_v31_promote_dataset(uuid)'::regprocedure)
 IS DISTINCT FROM (SELECT definition FROM v31_promote_rpc_before)
 THEN RAISE EXCEPTION 'V31 seal RPC changed promotion'; END IF;
END;
$probe$;
-- Following unchanged certified-v31.sql exercises actual seal success and all
-- malformed/source/heldout refusals under these exact function settings.
SELECT 'V31_SEAL_RPC_BUDGET_METADATA_OK';
