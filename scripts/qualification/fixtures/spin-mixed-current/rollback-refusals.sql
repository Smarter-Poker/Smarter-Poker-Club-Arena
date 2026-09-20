\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='1s';
SELECT set_config('spin_mixed_qualification.rollback_body', :'rollback_body', true);
DO $isolation$
BEGIN
 IF session_user<>'fixture_bootstrap' OR current_user<>'fixture_bootstrap'
 OR NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
 OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
 OR current_database()<>'qual_spin_expiry_'||replace(current_setting('spin_mixed_qualification.execution_uuid')::uuid::text,'-','')
 OR md5(current_setting('spin_mixed_qualification.rollback_body'))<>'456493c28cbc4ece2254ca2aaec0ebce'
 THEN RAISE EXCEPTION 'wrong private rollback fault boundary/source'; END IF;
END $isolation$;
CREATE FUNCTION pg_temp.rollback_control_catalog() RETURNS jsonb LANGUAGE sql AS $q$
 SELECT jsonb_build_object(
 'functions',(SELECT jsonb_agg(jsonb_build_object('oid',p.oid,'owner',p.proowner,'acl',p.proacl::text,
   'config',p.proconfig,'security',p.prosecdef,'volatility',p.provolatile,'definition',pg_get_functiondef(p.oid)) ORDER BY p.oid)
  FROM pg_proc p WHERE p.oid IN (
   'public.fn_ca_settlement_lane_doctrine()'::regprocedure,
   'public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure,
   'public.fn_settle_tournament_places(uuid,uuid)'::regprocedure,
   'public.fn_ca_spin_mixed_lock_initial_v1(uuid,uuid,text)'::regprocedure,
   'public.fn_ca_spin_mixed_admit_v1(uuid,uuid)'::regprocedure,
   'public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure)),
 'basis',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY tournament_id),'[]'::jsonb) FROM public.ca_spin_mixed_basis_v1 r),
 'completion',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY tournament_id),'[]'::jsonb) FROM public.ca_spin_mixed_completion_v1 r),
 'dispatch',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY tournament_id),'[]'::jsonb) FROM public.ca_spin_mixed_dispatch_v1 r));
$q$;
DO $rollback_refusals$
DECLARE sig text; kind text; message text; observed boolean; baseline jsonb; n integer:=0;
BEGIN
 baseline:=pg_temp.rollback_control_catalog();
 FOREACH sig IN ARRAY ARRAY[
  'public.fn_ca_settlement_lane_doctrine()',
  'public.fn_complete_tournament_terminal(uuid,uuid,text)',
  'public.fn_settle_tournament_places(uuid,uuid)',
  'public.fn_ca_tournament_terminal_receipt(uuid,uuid)'] LOOP
  FOREACH kind IN ARRAY ARRAY['owner','acl'] LOOP
   observed:=false;
   BEGIN
    IF kind='owner' THEN
     EXECUTE format('ALTER FUNCTION %s OWNER TO service_role',sig);
    ELSE
     EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',sig);
    END IF;
    EXECUTE 'SET LOCAL ROLE postgres';
    IF current_user<>'postgres' OR (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
     THEN RAISE EXCEPTION 'rollback did not use nonsuper postgres'; END IF;
    BEGIN
     EXECUTE current_setting('spin_mixed_qualification.rollback_body');
     RAISE EXCEPTION 'rollback accepted owner/ACL drift' USING ERRCODE='PZ999';
    EXCEPTION WHEN SQLSTATE '55000' THEN
     GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
     IF message IS DISTINCT FROM 'mixed current rollback public authority differs: '||substr(sig,8)
      THEN RAISE EXCEPTION 'wrong rollback refusal: %',message; END IF;
     observed:=true;
    END;
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'rollback injected catalog drift' USING ERRCODE='PZ902';
   EXCEPTION WHEN SQLSTATE 'PZ902' THEN NULL;
   END;
   IF NOT observed OR current_user<>'fixture_bootstrap'
    OR pg_temp.rollback_control_catalog() IS DISTINCT FROM baseline
    THEN RAISE EXCEPTION 'catalog/evidence did not recover after exact refusal'; END IF;
   n:=n+1;
  END LOOP;
 END LOOP;
 IF n<>8 THEN RAISE EXCEPTION 'missing rollback refusal case'; END IF;
 PERFORM set_config('spin_mixed_qualification.rollback_negative_count',n::text,true);
END $rollback_refusals$;
SELECT jsonb_build_object('rollback_owner_acl_refusals',current_setting('spin_mixed_qualification.rollback_negative_count')::integer);
ROLLBACK;
