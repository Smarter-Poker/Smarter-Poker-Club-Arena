-- The seal RPC performs the complete corpus proof, not one ordinary API read.
-- A real 106-cell / 212-artifact build reached sealing but inherited the
-- generic service_role 8s limit despite the existing gateway's 270s budget.
-- PostgREST hoists per-function statement_timeout before the main RPC query:
-- https://docs.postgrest.org/en/stable/references/transactions.html#hoisted-function-settings
-- Bound this RPC to 240s and fail a contended lock after 1s. No function body,
-- quality gate, source receipt, approval, privilege or global role is changed.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $budget$
DECLARE b record;
BEGIN
 SELECT * INTO STRICT b FROM pg_proc
 WHERE oid='public.fn_gto_v31_seal_build(uuid)'::regprocedure;
 IF md5(pg_get_functiondef(b.oid)) IS DISTINCT FROM 'bc390a78ca6fca87aeaca253219cd6f3' THEN
  RAISE EXCEPTION 'V31 seal RPC budget exact preimage differs';
 END IF;
 EXECUTE 'ALTER FUNCTION public.fn_gto_v31_seal_build(uuid) SET statement_timeout=''240s''';
 EXECUTE 'ALTER FUNCTION public.fn_gto_v31_seal_build(uuid) SET lock_timeout=''1s''';
 IF NOT EXISTS (
  SELECT 1 FROM pg_proc p WHERE p.oid=b.oid AND p.prosrc=b.prosrc
   AND p.proowner=b.proowner AND p.proacl IS NOT DISTINCT FROM b.proacl
   AND p.prosecdef=b.prosecdef AND p.prorettype=b.prorettype
   AND p.proargtypes=b.proargtypes AND p.provolatile=b.provolatile
   AND p.proparallel=b.proparallel AND p.proleakproof=b.proleakproof
   AND p.proconfig IS NOT DISTINCT FROM b.proconfig||ARRAY['statement_timeout=240s','lock_timeout=1s']::text[]
 ) THEN RAISE EXCEPTION 'V31 seal RPC budget changed body, privileges or unrelated settings'; END IF;
END;
$budget$;
-- @live-proof: fn_gto_v31_seal_build(uuid) retains its exact source body,
-- ownership, ACL, SECURITY DEFINER and search_path; proconfig appends only
-- statement_timeout=240s and lock_timeout=1s; service_role remains at 8s.
COMMIT;
