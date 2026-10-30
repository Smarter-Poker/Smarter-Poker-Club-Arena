-- Isolated native PG17: reproduce the installed eight-operation ingress owner.
DO $probe$
DECLARE item record; actor text; op text; n integer:=0; refused boolean;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('COMPACTOR','prepare_model'),('COMPACTOR','freeze_model'),('M2','model_freeze_authority')
  ) AS allowed(principal,operation) LOOP
    refused:=false;
    BEGIN
      PERFORM public.fn_solver_ingress_claim(item.principal,
        ('f3100000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
        item.operation,clock_timestamp(),repeat('a',64));
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM<>'solver ingress identity is invalid or stale' THEN RAISE; END IF;
      refused:=true;
    END;
    IF NOT refused THEN RAISE EXCEPTION 'original ingress unexpectedly admitted %',item.operation; END IF;
    refused:=false;
    BEGIN
      INSERT INTO public.solver_ingress_nonces(principal,nonce,operation,signed_at,body_sha256)
      VALUES(item.principal,('f3100000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
        item.operation,clock_timestamp(),repeat('a',64));
    EXCEPTION WHEN check_violation THEN refused:=true;
    END;
    IF NOT refused THEN RAISE EXCEPTION 'original nonce CHECK unexpectedly admitted %',item.operation; END IF;
    n:=n+1;
  END LOOP;
  FOREACH actor IN ARRAY ARRAY['M1','M2','COMPACTOR'] LOOP
    FOREACH op IN ARRAY ARRAY['dataset_contract','worker_heartbeat','ingest_artifact',
      'register_dataset','build_cell','seal_dataset','compact_heartbeat','certification_status'] LOOP
      n:=n+1;
      IF NOT public.fn_solver_ingress_claim(actor,
        ('f3100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,op,clock_timestamp(),repeat('a',64)) THEN
        RAISE EXCEPTION 'original legacy actor/operation refused';
      END IF;
    END LOOP;
  END LOOP;
END;
$probe$;
-- Match the observed live nonce-log population, without any real identities.
INSERT INTO public.solver_ingress_nonces(principal,nonce,operation,signed_at,body_sha256)
SELECT 'COMPACTOR',('f3100002-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
 'certification_status',clock_timestamp(),repeat('e',64)
FROM generate_series(1,31031) AS fixture(i);
CREATE TABLE public.v31_ingress_prior_snapshot AS
SELECT count(*) AS row_count,md5(string_agg(row_to_json(n)::text,'' ORDER BY principal,nonce)) AS fingerprint,
 (SELECT oid FROM pg_proc WHERE oid='public.fn_solver_ingress_claim(text,uuid,text,timestamptz,text)'::regprocedure) AS function_oid,
 (SELECT proowner FROM pg_proc WHERE oid='public.fn_solver_ingress_claim(text,uuid,text,timestamptz,text)'::regprocedure) AS function_owner,
 (SELECT proacl FROM pg_proc WHERE oid='public.fn_solver_ingress_claim(text,uuid,text,timestamptz,text)'::regprocedure) AS function_acl,
 (SELECT proconfig FROM pg_proc WHERE oid='public.fn_solver_ingress_claim(text,uuid,text,timestamptz,text)'::regprocedure) AS function_config
FROM public.solver_ingress_nonces n;
DO $probe$ BEGIN
 IF (SELECT row_count FROM public.v31_ingress_prior_snapshot)<>31055 THEN
  RAISE EXCEPTION 'original ingress fixture must retain24 legacy combinations and31031 historical rows';
 END IF;
END $probe$;
SELECT 'V31_MODEL_INGRESS_OLD_REFUSAL_REPRODUCED' AS result;
