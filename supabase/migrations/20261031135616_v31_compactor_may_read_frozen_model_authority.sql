-- 20261031135616_v31_compactor_may_read_frozen_model_authority
-- Reserved by scripts/reserve-migration-version.sh.
-- TIER: 2. AFFECTS: solver ingress function and nonce operation CHECK only.
-- WHY: The protected gateway admits M2 and COMPACTOR authority reads, but both
-- database ingress owners admitted only M2. Completed R7 qualification stopped
-- with HTTP 409 before its first build. Align this read-only operation at both
-- owners; M1 remains refused and private model writes remain COMPACTOR-only.
-- No model, source, cell, evaluation, certification or player row is changed.
-- Preserve the legacy operation domain, five-minute freshness, body digest,
-- principal/nonce uniqueness, function identity/ACL/settings and table RLS.
-- Exact installed preimages were read on 2026-10-31 at 13:56:03 UTC.
-- Native PostgreSQL 17 exercises the original rejection and corrected domain.
-- Rollback: a new protected migration may restore the two exact predicates
-- below after excluding new COMPACTOR authority nonce rows from its old CHECK;
-- never delete audit nonces or replay/edit this installed migration.
--
-- @live-proof: md5(pg_get_functiondef('public.fn_solver_ingress_claim(text,uuid,text,timestamptz,text)'::regprocedure))='051c172d4ae8cf8856bcbd320a1b3e28'
-- @live-proof: EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.solver_ingress_nonces'::regclass AND conname='solver_ingress_nonces_operation_check' AND convalidated AND md5(pg_get_constraintdef(oid))='d9930cbff758f7d4f5fef9a614c2eb47')
-- @live-proof: EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_solver_ingress_claim(text,uuid,text,timestamptz,text)'::regprocedure AND prosecdef AND proconfig=ARRAY['search_path=public']::text[] AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') AND has_function_privilege('service_role',oid,'EXECUTE'))

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $authority_read$
DECLARE
  v_function regprocedure := 'public.fn_solver_ingress_claim(text,uuid,text,timestamptz,text)'::regprocedure;
  v_before jsonb;
  v_table_before jsonb;
  v_definition text;
BEGIN
  SELECT to_jsonb(p)-'prosrc', pg_get_functiondef(p.oid)
    INTO v_before, v_definition FROM pg_proc p WHERE p.oid=v_function;
  SELECT to_jsonb(c) INTO v_table_before FROM pg_class c
    WHERE c.oid='public.solver_ingress_nonces'::regclass;
  IF md5(v_definition)<>'d2e67eb56feb819478c725888a2b906f'
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid='public.solver_ingress_nonces'::regclass
         AND conname='solver_ingress_nonces_operation_check' AND convalidated
         AND md5(pg_get_constraintdef(oid))='8fe624a3f070e1b8b8515d14f421a4a9'
     ) THEN
    RAISE EXCEPTION 'V31 compactor authority requires the exact installed replay-gate preimage';
  END IF;

  ALTER TABLE public.solver_ingress_nonces
    DROP CONSTRAINT solver_ingress_nonces_operation_check,
    ADD CONSTRAINT solver_ingress_nonces_operation_check CHECK ((
      operation IN ('dataset_contract','worker_heartbeat','ingest_artifact',
        'register_dataset','build_cell','seal_dataset','compact_heartbeat','certification_status')
      OR (principal='COMPACTOR' AND operation IN ('prepare_model','freeze_model'))
      OR (principal IN ('M2','COMPACTOR') AND operation='model_freeze_authority')
    ) IS TRUE);

  -- Replace only this predicate in the exact installed definition. All other
  -- source bytes and CREATE OR REPLACE function metadata remain unchanged.
  EXECUTE replace(v_definition,
    '(p_operation=''model_freeze_authority'' AND p_principal<>''M2'')',
    '(p_operation=''model_freeze_authority'' AND p_principal NOT IN (''M2'',''COMPACTOR''))');

  IF md5(pg_get_functiondef(v_function))<>'051c172d4ae8cf8856bcbd320a1b3e28'
     OR v_before IS DISTINCT FROM (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=v_function)
     OR v_table_before IS DISTINCT FROM (SELECT to_jsonb(c) FROM pg_class c WHERE c.oid='public.solver_ingress_nonces'::regclass)
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid='public.solver_ingress_nonces'::regclass
         AND conname='solver_ingress_nonces_operation_check' AND convalidated
         AND md5(pg_get_constraintdef(oid))='d9930cbff758f7d4f5fef9a614c2eb47'
     ) THEN
    RAISE EXCEPTION 'V31 authority read changed an unexpected ingress property';
  END IF;
END;
$authority_read$;

COMMIT;
