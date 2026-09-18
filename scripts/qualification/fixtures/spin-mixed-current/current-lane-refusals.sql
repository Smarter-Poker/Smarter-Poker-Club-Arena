\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='1s';
SET LOCAL timezone='UTC'; SET LOCAL search_path=public,pg_temp;
SELECT set_config('spin_mixed_qualification.current_lane_mode', :'lane_mode', true) AS mode;
SELECT set_config('spin_mixed_qualification.current_lane_body', :'lane_body', true) IS NOT NULL AS body_supplied;
SELECT set_config('spin_mixed_qualification.stale_doctrine', :'stale_doctrine', true) IS NOT NULL AS stale_supplied;
DO $isolation$
DECLARE mode text:=current_setting('spin_mixed_qualification.current_lane_mode');
BEGIN
 IF session_user<>'fixture_bootstrap' OR current_user<>'fixture_bootstrap'
 OR NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
 OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
 OR current_setting('port')<>'5432' OR current_setting('session_replication_role')<>'origin'
 OR current_database()<>'qual_spin_expiry_'||replace(current_setting('spin_mixed_qualification.execution_uuid')::uuid::text,'-','')
 OR mode NOT IN ('forward','rollback')
 OR md5(current_setting('spin_mixed_qualification.stale_doctrine'))<>'8dd361600c8facb1cbb99b3df853e5b9'
 OR md5(current_setting('spin_mixed_qualification.current_lane_body')) IS DISTINCT FROM
   (CASE mode WHEN 'forward' THEN '2ef348a0d4f6bacc4615748c9ce25ea8' ELSE '88d2276c59dd1646a986ee9a1b07749d' END) THEN
  RAISE EXCEPTION 'wrong current-lane private refusal boundary/source';
 END IF;
END $isolation$;
\ir current-lane-state.sql
DO $refusals$
DECLARE mode text:=current_setting('spin_mixed_qualification.current_lane_mode');
 sig text; kind text; message text; expected_message text; observed boolean;
 baseline jsonb; n integer:=0;
BEGIN
 baseline:=pg_temp.current_lane_state();
 FOR sig,kind IN
  SELECT s,k FROM unnest(ARRAY[
   'fn_complete_tournament_terminal(uuid,uuid,text)',
   'fn_ca_share_settlement_lane_for_table(uuid)',
   'settle_hand_atomically(uuid,uuid,jsonb)',
   'sp_compact_hand_history(integer,integer,integer)']) s
    CROSS JOIN unnest(ARRAY['owner','acl']) k
  UNION ALL SELECT 'fn_complete_tournament_terminal(uuid,uuid,text)','config'
  UNION ALL SELECT 'fn_ca_settlement_lane_doctrine()','stale_definition'
  UNION ALL SELECT 'fn_ca_serialize_legacy_settlement_receipt_statement()',k
    FROM unnest(ARRAY['owner','acl','config']) k WHERE mode='rollback'
 LOOP
  observed:=false;
  expected_message:=CASE WHEN sig='fn_ca_serialize_legacy_settlement_receipt_statement()'
    THEN 'current receipt lane handler authority differs'
    ELSE 'current receipt lane authority differs: '||sig END;
  BEGIN
   IF kind='stale_definition' THEN EXECUTE current_setting('spin_mixed_qualification.stale_doctrine');
   ELSIF kind='owner' THEN EXECUTE format('ALTER FUNCTION public.%s OWNER TO service_role',sig);
   ELSIF kind='acl' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated',sig);
   ELSE EXECUTE format('ALTER FUNCTION public.%s SET statement_timeout TO ''31s''',sig); END IF;
   EXECUTE 'SET LOCAL ROLE postgres';
   IF current_user<>'postgres' OR (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
    THEN RAISE EXCEPTION 'current-lane negative did not use nonsuper postgres'; END IF;
   BEGIN
    EXECUTE current_setting('spin_mixed_qualification.current_lane_body');
    RAISE EXCEPTION 'current-lane source accepted drift' USING ERRCODE='PZ999';
   EXCEPTION WHEN SQLSTATE '55000' THEN
    GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
    IF message IS DISTINCT FROM expected_message THEN
     RAISE EXCEPTION 'wrong current-lane refusal: %',message;
    END IF;
    observed:=true;
   END;
   EXECUTE 'RESET ROLE';
   RAISE EXCEPTION 'rollback injected current-lane drift' USING ERRCODE='PZ902';
  EXCEPTION WHEN SQLSTATE 'PZ902' THEN NULL;
  END;
  IF NOT observed OR current_user<>'fixture_bootstrap'
    OR pg_temp.current_lane_state() IS DISTINCT FROM baseline THEN
   RAISE EXCEPTION 'current-lane refusal changed authority or business state';
  END IF;
  n:=n+1;
 END LOOP;
 IF n IS DISTINCT FROM (CASE mode WHEN 'forward' THEN 10 ELSE 13 END) THEN
  RAISE EXCEPTION 'current-lane refusal inventory incomplete'; END IF;
 PERFORM set_config('spin_mixed_qualification.current_lane_negative_count',n::text,true);
END $refusals$;
SELECT jsonb_build_object('current_lane_mode',current_setting('spin_mixed_qualification.current_lane_mode'),
 'authority_refusals',current_setting('spin_mixed_qualification.current_lane_negative_count')::integer,
 'exact_state_restored',true);
ROLLBACK;
