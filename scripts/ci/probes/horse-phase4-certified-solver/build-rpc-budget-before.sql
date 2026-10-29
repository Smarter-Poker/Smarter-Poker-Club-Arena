\set ON_ERROR_STOP on
-- Disposable-cluster baseline: production's generic API role remains eight seconds.
ALTER ROLE service_role SET statement_timeout='8s';
CREATE TEMP TABLE v31_build_rpc_before AS
 SELECT oid,prosrc,proowner,proacl,prosecdef,proconfig,prorettype,proargtypes,
        provolatile,proparallel,proleakproof
 FROM pg_proc WHERE oid='public.fn_gto_v31_build_cell(uuid,jsonb)'::regprocedure;
CREATE TEMP TABLE v31_build_rpc_roles_before AS
 SELECT rolname,rolconfig FROM pg_roles WHERE rolname IN ('service_role','anon','authenticated');
CREATE TEMP TABLE v31_promote_rpc_before AS
 SELECT pg_get_functiondef('public.fn_gto_v31_promote_dataset(uuid)'::regprocedure) AS definition;
CREATE TEMP TABLE v31_seal_unchanged_before AS
 SELECT pg_get_functiondef('public.fn_gto_v31_seal_build(uuid)'::regprocedure) AS definition;
