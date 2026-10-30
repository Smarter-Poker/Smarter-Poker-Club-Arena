BEGIN;
CREATE FUNCTION pg_temp.expect_ingress_refusal(actor text,nonce uuid,op text,at_time timestamptz,body text,expected text)
RETURNS void LANGUAGE plpgsql AS $test$
DECLARE refused boolean:=false;
BEGIN
 BEGIN
  PERFORM public.fn_solver_ingress_claim(actor,nonce,op,at_time,body);
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM<>expected THEN RAISE; END IF;
  refused:=true;
 END;
 IF NOT refused THEN RAISE EXCEPTION 'ingress accepted refused actor/operation %/%',actor,op; END IF;
END;
$test$;
DO $probe$
DECLARE prior record; proc record; current_rows bigint; current_fingerprint text;
 item record; actor text; op text; n integer:=1000; key uuid; refused boolean;
 stale text:='solver ingress identity is invalid or stale';
BEGIN
 SELECT * INTO STRICT prior FROM public.v31_ingress_prior_snapshot;
 SELECT oid,proowner,proacl,proconfig,prosecdef INTO STRICT proc FROM pg_proc
 WHERE oid='public.fn_solver_ingress_claim(text,uuid,text,timestamptz,text)'::regprocedure;
 IF proc.oid<>prior.function_oid OR proc.proowner<>prior.function_owner
    OR proc.proacl IS DISTINCT FROM prior.function_acl OR proc.proconfig IS DISTINCT FROM prior.function_config
    OR NOT proc.prosecdef THEN RAISE EXCEPTION 'ingress function security identity changed'; END IF;
 SELECT count(*),md5(string_agg(row_to_json(x)::text,'' ORDER BY principal,nonce))
 INTO current_rows,current_fingerprint FROM public.solver_ingress_nonces x;
 IF current_rows<>prior.row_count OR current_fingerprint IS DISTINCT FROM prior.fingerprint THEN
  RAISE EXCEPTION 'ingress transition changed retained legacy nonce rows'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.solver_ingress_nonces'::regclass
   AND conname='solver_ingress_nonces_operation_check' AND convalidated) THEN
  RAISE EXCEPTION 'new ingress operation CHECK is not validated'; END IF;
 IF has_function_privilege('anon',proc.oid,'EXECUTE') OR has_function_privilege('authenticated',proc.oid,'EXECUTE')
    OR NOT has_function_privilege('service_role',proc.oid,'EXECUTE') THEN
  RAISE EXCEPTION 'ingress execution ACL changed'; END IF;
 FOR item IN SELECT * FROM (VALUES
   ('COMPACTOR','prepare_model'),('COMPACTOR','freeze_model'),('M2','model_freeze_authority')
 ) AS allowed(principal,operation) LOOP
  n:=n+1;key:=('f3100001-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  IF NOT public.fn_solver_ingress_claim(item.principal,key,item.operation,clock_timestamp(),repeat('b',64)) THEN
   RAISE EXCEPTION 'new scoped operation refused %',item.operation; END IF;
  PERFORM pg_temp.expect_ingress_refusal(item.principal,key,item.operation,clock_timestamp(),repeat('b',64),
    'solver ingress nonce was replayed');
  PERFORM pg_temp.expect_ingress_refusal(item.principal,key,'dataset_contract',clock_timestamp(),repeat('c',64),
    'solver ingress nonce was replayed');
  PERFORM pg_temp.expect_ingress_refusal(item.principal,gen_random_uuid(),item.operation,clock_timestamp()-interval '301 seconds',repeat('b',64),stale);
  PERFORM pg_temp.expect_ingress_refusal(item.principal,gen_random_uuid(),item.operation,clock_timestamp()+interval '301 seconds',repeat('b',64),stale);
  PERFORM pg_temp.expect_ingress_refusal(item.principal,gen_random_uuid(),item.operation,NULL,repeat('b',64),stale);
  PERFORM pg_temp.expect_ingress_refusal(item.principal,gen_random_uuid(),item.operation,clock_timestamp(),repeat('0',64),stale);
  PERFORM pg_temp.expect_ingress_refusal(item.principal,gen_random_uuid(),item.operation,clock_timestamp(),repeat('B',64),stale);
  PERFORM pg_temp.expect_ingress_refusal(item.principal,gen_random_uuid(),item.operation,clock_timestamp(),NULL,stale);
  PERFORM pg_temp.expect_ingress_refusal(item.principal,NULL,item.operation,clock_timestamp(),repeat('b',64),stale);
  FOREACH actor IN ARRAY ARRAY['M1','M2','COMPACTOR'] LOOP
   IF actor=item.principal THEN CONTINUE; END IF;
   PERFORM pg_temp.expect_ingress_refusal(actor,gen_random_uuid(),item.operation,clock_timestamp(),repeat('b',64),stale);
   refused:=false;
   BEGIN
    INSERT INTO public.solver_ingress_nonces(principal,nonce,operation,signed_at,body_sha256)
    VALUES(actor,gen_random_uuid(),item.operation,clock_timestamp(),repeat('b',64));
   EXCEPTION WHEN check_violation THEN refused:=true;
   END;
   IF NOT refused THEN RAISE EXCEPTION 'table CHECK admitted wrong new-operation actor'; END IF;
  END LOOP;
 END LOOP;
 PERFORM pg_temp.expect_ingress_refusal('COMPACTOR',gen_random_uuid(),'prepare_model_extra',clock_timestamp(),repeat('b',64),stale);
 PERFORM pg_temp.expect_ingress_refusal('COMPACTOR',gen_random_uuid(),'PREPARE_MODEL',clock_timestamp(),repeat('b',64),stale);
 PERFORM pg_temp.expect_ingress_refusal(NULL,gen_random_uuid(),'prepare_model',clock_timestamp(),repeat('b',64),stale);
 PERFORM pg_temp.expect_ingress_refusal('UNKNOWN',gen_random_uuid(),'prepare_model',clock_timestamp(),repeat('b',64),stale);
 PERFORM pg_temp.expect_ingress_refusal('COMPACTOR',gen_random_uuid(),NULL,clock_timestamp(),repeat('b',64),stale);
 FOREACH actor IN ARRAY ARRAY['M1','M2','COMPACTOR'] LOOP
  FOREACH op IN ARRAY ARRAY['dataset_contract','worker_heartbeat','ingest_artifact',
    'register_dataset','build_cell','seal_dataset','compact_heartbeat','certification_status'] LOOP
   IF NOT public.fn_solver_ingress_claim(actor,gen_random_uuid(),op,clock_timestamp(),repeat('d',64)) THEN
    RAISE EXCEPTION 'new ingress changed a legacy actor/operation'; END IF;
  END LOOP;
 END LOOP;
END;
$probe$;
ROLLBACK;
-- Restore the exact empty prior fixture domain for the other existing probes.
DELETE FROM public.solver_ingress_nonces WHERE nonce::text LIKE 'f3100000-%' OR nonce::text LIKE 'f3100002-%';
DROP TABLE public.v31_ingress_prior_snapshot;
SELECT 'V31_MODEL_INGRESS_SCOPED_REPLAY_AND_LEGACY_TRANSITION_OK' AS result;
