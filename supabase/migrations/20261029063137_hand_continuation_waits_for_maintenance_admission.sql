-- @live-proof: (SELECT count(*)=3 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.fn_f06_retain_hand_continuation(uuid,uuid,uuid,bigint,bigint,text,text)'),to_regprocedure('public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)'),to_regprocedure('public.fn_f06_claim_legacy_river_continuation(uuid,uuid,uuid,bigint,timestamp with time zone,text,text)')) AND md5(pg_get_functiondef(p.oid)) IN ('12e99125964489c51d9c7bb29e915750','1ae0c66875b9a8b72c85e12d052ce1f1','edafd51e3e4502cb009ec3158c8f2bc2') AND p.prosecdef AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND has_function_privilege('service_role',p.oid,'EXECUTE'))
-- Reserved with scripts/reserve-migration-version.sh; production preimages
-- read independently 2026-10-29. Welcome fixture retirement legitimately owns
-- the exclusive platform gate while a different table retains its original.
-- A fail-fast shared acquisition made brief cleanup contention kill that table.
-- Wait in this SAME original transaction, before F06/row locks, for at most
-- five seconds (less than the existing eight-second RPC deadline). Preserve a
-- stricter caller lock_timeout and restore it before subsequent row locking.
-- No retry, lease bypass, freeze bypass, cleanup-lock change or replay.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';
DO $patch$
DECLARE item record; signature regprocedure; before_text text; after_text text;
 prior_acl aclitem[]; prior_config text[];
 old_fragment text := $old$IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_MAINTENANCE_BUSY' USING ERRCODE='55P03'; END IF;$old$;
 new_fragment text := $new$DECLARE prior_lock_timeout text := current_setting('lock_timeout');
  BEGIN
    IF prior_lock_timeout::interval = interval '0'
       OR prior_lock_timeout::interval > interval '5 seconds' THEN
      PERFORM set_config('lock_timeout','5s',true);
    END IF;
    PERFORM pg_advisory_xact_lock_shared(530090,1);
    PERFORM set_config('lock_timeout',prior_lock_timeout,true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('lock_timeout',prior_lock_timeout,true);
    RAISE;
  END;$new$;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('public.fn_f06_retain_hand_continuation(uuid,uuid,uuid,bigint,bigint,text,text)','a3c4bb0187c9433e4e93712d0a6f3ae6'),
  ('public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)','a633c51983e18c18de73be2caf75bc9c'),
  ('public.fn_f06_claim_legacy_river_continuation(uuid,uuid,uuid,bigint,timestamp with time zone,text,text)','49b9c2f115e09bc16059b24ad7f2bdd4')
 ) AS pins(sig,pre_hash) LOOP
  signature := item.sig::regprocedure;
  before_text := pg_get_functiondef(signature);
  -- The legacy function's retained source has one space of indentation.
  IF item.sig LIKE '%legacy%' THEN
    old_fragment := replace(old_fragment,E'\n    RAISE',E'\n  RAISE');
  END IF;
  IF md5(before_text) <> item.pre_hash
     OR (length(before_text)-length(replace(before_text,old_fragment,'')))/length(old_fragment) <> 1 THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_ADMISSION_PREIMAGE_CHANGED: %',item.sig;
  END IF;
  SELECT proacl,proconfig INTO prior_acl,prior_config FROM pg_proc WHERE oid=signature;
  EXECUTE replace(before_text,old_fragment,new_fragment);
  after_text := pg_get_functiondef(signature);
  IF md5(replace(after_text,new_fragment,old_fragment)) <> item.pre_hash
     OR (SELECT proacl FROM pg_proc WHERE oid=signature) IS DISTINCT FROM prior_acl
     OR (SELECT proconfig FROM pg_proc WHERE oid=signature) IS DISTINCT FROM prior_config
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid=signature)
     OR has_function_privilege('anon',signature,'EXECUTE')
     OR has_function_privilege('authenticated',signature,'EXECUTE')
     OR NOT has_function_privilege('service_role',signature,'EXECUTE') THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_ADMISSION_POSTIMAGE_CHANGED: %',item.sig;
  END IF;
 END LOOP;
END $patch$;
COMMIT;
