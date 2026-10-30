-- 20261030023627_v31_model_operations_enter_the_scoped_replay_gate.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- The public215 producer already signs prepare_model, freeze_model and
-- model_freeze_authority. The original nonce function and table CHECK still
-- knew only the eight legacy operations, so an authenticated private prepare
-- failed before creating any model. Admit these three explicit operations at
-- both owners, scoped to COMPACTOR writes and M2 authority reads respectively.
-- Preserve the legacy operation domain, five-minute freshness, canonical body
-- digest, principal/nonce replay identity, function owner, ACL and search path.

-- @live-proof: md5(pg_get_functiondef('public.fn_solver_ingress_claim(text,uuid,text,timestamptz,text)'::regprocedure))='d2e67eb56feb819478c725888a2b906f'
-- @live-proof: EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.solver_ingress_nonces'::regclass AND conname='solver_ingress_nonces_operation_check' AND convalidated AND md5(pg_get_constraintdef(oid))='8fe624a3f070e1b8b8515d14f421a4a9')
-- @live-proof: EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_solver_ingress_claim(text,uuid,text,timestamptz,text)'::regprocedure AND prosecdef AND proconfig=ARRAY['search_path=public']::text[] AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') AND has_function_privilege('service_role',oid,'EXECUTE'))

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $preimage$
BEGIN
  IF md5(pg_get_functiondef('public.fn_solver_ingress_claim(text,uuid,text,timestamptz,text)'::regprocedure))
       <> 'fd5ebf3b42393a9405dc70ca8919f0a3'
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid='public.solver_ingress_nonces'::regclass
         AND conname='solver_ingress_nonces_operation_check' AND convalidated
         AND md5(pg_get_constraintdef(oid))='2cabf6a2bb0690ed9b109ab3dc9dd078'
     ) THEN
    RAISE EXCEPTION 'V31 ingress model operations require the exact original replay-gate preimage';
  END IF;
END;
$preimage$;

-- One short lock attempt and a validated CHECK over the existing nonce log.
-- No player, money, runtime-cell, model, source or certification row is changed.
ALTER TABLE public.solver_ingress_nonces
  DROP CONSTRAINT solver_ingress_nonces_operation_check,
  ADD CONSTRAINT solver_ingress_nonces_operation_check CHECK ((
    operation IN ('dataset_contract','worker_heartbeat','ingest_artifact',
      'register_dataset','build_cell','seal_dataset','compact_heartbeat','certification_status')
    OR (principal='COMPACTOR' AND operation IN ('prepare_model','freeze_model'))
    OR (principal='M2' AND operation='model_freeze_authority')
  ) IS TRUE);

CREATE OR REPLACE FUNCTION public.fn_solver_ingress_claim(
  p_principal text,
  p_nonce uuid,
  p_operation text,
  p_signed_at timestamptz,
  p_body_sha256 text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_inserted integer;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF p_principal IS NULL OR p_principal NOT IN ('M1','M2','COMPACTOR')
     OR p_nonce IS NULL OR p_operation IS NULL
     OR p_operation NOT IN ('dataset_contract','worker_heartbeat','ingest_artifact',
       'register_dataset','build_cell','seal_dataset','compact_heartbeat',
       'certification_status','prepare_model','freeze_model','model_freeze_authority')
     OR (p_operation IN ('prepare_model','freeze_model') AND p_principal<>'COMPACTOR')
     OR (p_operation='model_freeze_authority' AND p_principal<>'M2')
     OR p_signed_at IS NULL OR abs(extract(epoch FROM (clock_timestamp()-p_signed_at)))>300
     OR COALESCE(p_body_sha256,'') !~ '^[0-9a-f]{64}$'
     OR p_body_sha256=repeat('0',64) THEN
    RAISE EXCEPTION 'solver ingress identity is invalid or stale';
  END IF;

  DELETE FROM public.solver_ingress_nonces WHERE received_at<now()-interval '2 days';
  INSERT INTO public.solver_ingress_nonces(principal,nonce,operation,signed_at,body_sha256)
  VALUES(p_principal,p_nonce,p_operation,p_signed_at,p_body_sha256)
  ON CONFLICT (principal,nonce) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted<>1 THEN RAISE EXCEPTION 'solver ingress nonce was replayed'; END IF;
  RETURN true;
END;
$fn$;

COMMIT;
