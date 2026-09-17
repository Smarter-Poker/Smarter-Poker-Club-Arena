-- Nonfinancial lane/catalog controls only; no terminal or historical admission.
\set ON_ERROR_STOP on
SET statement_timeout='20s'; SET lock_timeout='1s'; SET timezone='UTC';
SET search_path=public,pg_temp;
\ir fixtures/spin-receipt-lane/boundary.sql
\ir fixtures/spin-history-retention/database-state.sql
\ir fixtures/spin-receipt-lane/state.sql
\ir fixtures/spin-receipt-lane/component-inputs.sql
CREATE TEMP TABLE receipt_lane_before AS SELECT pg_temp.receipt_lane_catalog() catalog,
 pg_temp.retention_database_state() business;
CREATE TEMP TABLE receipt_lane_cohort_result(before_reproduced boolean NOT NULL,
 reverse_prerequisite_refusals integer NOT NULL);
BEGIN;
DO $controls$
DECLARE src record; before record; message text; mode integer;
 original_forward text; before_reproduced boolean := false; reverse_refusals integer := 0;
 reverse_guards constant text := $reverse_guards$     OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
          WHERE p.oid=to_regprocedure('public.fn_complete_tournament_terminal(uuid,uuid,text)'))
          IS DISTINCT FROM '480be3139fe0878e637ce54f533a2170'
     OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
          WHERE p.oid=to_regprocedure('public.fn_settle_tournament_places(uuid,uuid)'))
          IS DISTINCT FROM 'c412c8b17186976df139f73a706175f2'
$reverse_guards$;
BEGIN
 SELECT * INTO STRICT src FROM receipt_lane_sources;
 SELECT * INTO STRICT before FROM receipt_lane_before;
 IF pg_temp.receipt_lane_handler() IS NOT NULL THEN
  RAISE EXCEPTION 'receipt lane must begin without candidate handler'; END IF;
 -- The genuine original compactor must reach its old accepted path. Each
 -- subtransaction restores the policy timestamp and temporary refusal trigger.
 BEGIN
  EXECUTE src.compactor_sql;
  RAISE EXCEPTION USING ERRCODE='PZ910',MESSAGE='receipt lane original compactor checked';
 EXCEPTION WHEN SQLSTATE 'PZ910' THEN
  GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
  IF message<>'receipt lane original compactor checked' THEN RAISE; END IF;
 END;
 -- Fault the real prerequisite identity and authority, never a financial body.
 FOR mode IN 1..3 LOOP
  BEGIN
   IF mode=1 THEN
    ALTER FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) RENAME TO lane_missing_shared_authority;
   ELSIF mode=2 THEN
    REVOKE EXECUTE ON FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) FROM service_role;
   ELSE
    GRANT CREATE ON SCHEMA public TO service_role;
    ALTER FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) OWNER TO service_role;
   END IF;
   -- A constant regprocedure cast resolves when its SQL expression is planned.
   -- The missing-helper case must not plan the authority-only source lookup.
   IF mode<>1 THEN
    IF md5(pg_get_functiondef('public.fn_ca_share_settlement_lane_for_table(uuid)'::regprocedure))
         IS DISTINCT FROM '409b14ee72ce888d3b26524c52d49a68' THEN
     RAISE EXCEPTION 'authority-only fault unexpectedly changed shared helper source'; END IF;
   END IF;
   BEGIN
    EXECUTE src.forward_sql;
    RAISE EXCEPTION 'receipt lane accepted missing or changed shared authority %',mode;
   EXCEPTION WHEN SQLSTATE '55000' THEN
    GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
    IF message<>'legacy receipt lane prerequisite preimage differs' THEN RAISE; END IF;
   END;
   RAISE EXCEPTION USING ERRCODE='PZ911',MESSAGE='receipt lane prerequisite refusal checked';
  EXCEPTION WHEN SQLSTATE 'PZ911' THEN
   GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
   IF message<>'receipt lane prerequisite refusal checked' THEN RAISE; END IF;
  END;
 END LOOP;
 IF pg_temp.receipt_lane_catalog() IS DISTINCT FROM before.catalog
    OR pg_temp.retention_database_state() IS DISTINCT FROM before.business THEN
  RAISE EXCEPTION 'receipt lane original controls did not restore exact state'; END IF;
 -- The digest comes independently from committed 79d045d4's e6595446 forward,
 -- with only its outer BEGIN/COMMIT removed. Reproduce the old install/reverse
 -- mismatch using actual DDL; no financial function body is replaced or invoked.
 original_forward := replace(src.forward_sql,reverse_guards,'');
 IF original_forward=src.forward_sql
    OR md5(original_forward)<>'a8be23df9188a91c63fb88c2813954ad' THEN
  RAISE EXCEPTION 'receipt lane original cohort-control source differs'; END IF;
 IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
      WHERE p.oid=to_regprocedure('public.fn_complete_tournament_terminal(uuid,uuid,text)'))
      IS DISTINCT FROM '480be3139fe0878e637ce54f533a2170'
    OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
      WHERE p.oid=to_regprocedure('public.fn_settle_tournament_places(uuid,uuid)'))
      IS DISTINCT FROM 'c412c8b17186976df139f73a706175f2' THEN
  RAISE EXCEPTION 'receipt lane original reverse cohort differs'; END IF;
 BEGIN
  ALTER FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) SET statement_timeout='46s';
  EXECUTE original_forward;
  IF pg_temp.receipt_lane_handler() IS DISTINCT FROM
     '{"owner":"postgres","acl":"{postgres=X/postgres}","body_md5":"534850c97847e72075044d8604b0a09d","config":["search_path=pg_catalog, public, pg_temp"],"security_definer":false,"volatility":"v"}'::jsonb
     OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
          AND tgfoid=to_regprocedure('public.fn_ca_serialize_legacy_settlement_receipt_statement()'))<>3
     OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
          WHERE p.oid=to_regprocedure('public.settle_hand_atomically(uuid,uuid,jsonb)'))
          IS DISTINCT FROM '64abd1e3234fdabc655647bfb1ad5018' THEN
   RAISE EXCEPTION 'receipt lane original did not actually install under changed cohort'; END IF;
  BEGIN
   EXECUTE src.rollback_sql;
   RAISE EXCEPTION 'receipt lane original unexpectedly reversed changed cohort';
  EXCEPTION WHEN SQLSTATE '55000' THEN
   GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
   IF message<>'legacy receipt lane rollback authority/source differs' THEN RAISE; END IF;
  END;
  RAISE EXCEPTION USING ERRCODE='PZ914',MESSAGE='receipt lane original cohort mismatch reproduced';
 EXCEPTION WHEN SQLSTATE 'PZ914' THEN
  GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
  IF message<>'receipt lane original cohort mismatch reproduced' THEN RAISE; END IF;
  before_reproduced := true;
 END;
 IF pg_temp.receipt_lane_catalog() IS DISTINCT FROM before.catalog
    OR pg_temp.retention_database_state() IS DISTINCT FROM before.business
    OR pg_temp.receipt_lane_handler() IS NOT NULL THEN
  RAISE EXCEPTION 'receipt lane original cohort reproduction did not restore exact state'; END IF;
 -- Each reverse prerequisite must exist with the exact qualified definition.
 -- Timeout metadata changes alter pg_get_functiondef without replacing a body.
 FOR mode IN 1..4 LOOP
  BEGIN
   IF mode=1 THEN
    ALTER FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) RENAME TO lane_missing_terminal_cohort;
   ELSIF mode=2 THEN
    ALTER FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) SET statement_timeout='46s';
   ELSIF mode=3 THEN
    ALTER FUNCTION public.fn_settle_tournament_places(uuid,uuid) RENAME TO lane_missing_places_cohort;
   ELSE
    ALTER FUNCTION public.fn_settle_tournament_places(uuid,uuid) SET statement_timeout='31s';
   END IF;
   BEGIN
    EXECUTE src.forward_sql;
    RAISE EXCEPTION 'receipt lane accepted missing or changed reverse prerequisite %',mode;
   EXCEPTION WHEN SQLSTATE '55000' THEN
    GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
    IF message<>'legacy receipt lane prerequisite preimage differs' THEN RAISE; END IF;
   END;
   IF pg_temp.receipt_lane_handler() IS NOT NULL THEN
    RAISE EXCEPTION 'receipt lane prerequisite refusal left its handler'; END IF;
   RAISE EXCEPTION USING ERRCODE='PZ915',MESSAGE='receipt lane reverse prerequisite refusal checked';
  EXCEPTION WHEN SQLSTATE 'PZ915' THEN
   GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
   IF message<>'receipt lane reverse prerequisite refusal checked' THEN RAISE; END IF;
   reverse_refusals := reverse_refusals+1;
  END;
  IF pg_temp.receipt_lane_catalog() IS DISTINCT FROM before.catalog
     OR pg_temp.retention_database_state() IS DISTINCT FROM before.business
     OR pg_temp.receipt_lane_handler() IS NOT NULL THEN
   RAISE EXCEPTION 'receipt lane reverse prerequisite control % did not restore exact state',mode; END IF;
 END LOOP;
 IF NOT before_reproduced OR reverse_refusals<>4 THEN
  RAISE EXCEPTION 'receipt lane cohort controls incomplete'; END IF;
 EXECUTE src.forward_sql;
 IF pg_temp.receipt_lane_handler() IS DISTINCT FROM
  '{"owner":"postgres","acl":"{postgres=X/postgres}","body_md5":"534850c97847e72075044d8604b0a09d","config":["search_path=pg_catalog, public, pg_temp"],"security_definer":false,"volatility":"v"}'::jsonb THEN
  RAISE EXCEPTION 'receipt lane handler authority differs'; END IF;
 -- Every existing procedure retains its OID and all metadata except prosrc.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(before.catalog->'functions') old
   FULL JOIN jsonb_array_elements(pg_temp.receipt_lane_catalog()->'functions') new
    ON old#>'{proc,oid}'=new#>'{proc,oid}'
   WHERE ((old-'proc')||((old->'proc')-'prosrc')) IS DISTINCT FROM
         ((new-'proc')||((new->'proc')-'prosrc'))) THEN
  RAISE EXCEPTION 'receipt lane changed existing function metadata'; END IF;
 BEGIN
  EXECUTE src.forward_sql;
  RAISE EXCEPTION 'receipt lane replay was incorrectly admitted';
 EXCEPTION WHEN SQLSTATE '55000' THEN
  GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
  IF message<>'legacy receipt lane prerequisite preimage differs' THEN RAISE; END IF;
 END;
 BEGIN
  EXECUTE src.compactor_sql;
  RAISE EXCEPTION USING ERRCODE='PZ912',MESSAGE='receipt lane candidate compactor checked';
 EXCEPTION WHEN SQLSTATE 'PZ912' THEN
  GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
  IF message<>'receipt lane candidate compactor checked' THEN RAISE; END IF;
 END;
 -- The exact exception must not admit a disabled or broadened binding.
 FOR mode IN 1..7 LOOP
  BEGIN
   IF mode=1 THEN
    ALTER TABLE public.hand_history DISABLE TRIGGER a00_spin_mixed_history_identity_update_lane;
   ELSIF mode=2 THEN
    DROP TRIGGER a00_spin_mixed_history_identity_update_lane ON public.hand_history;
    CREATE TRIGGER a00_spin_mixed_history_identity_update_lane
      BEFORE UPDATE OF reported ON public.hand_history FOR EACH STATEMENT
      EXECUTE FUNCTION public.fn_ca_serialize_legacy_settlement_receipt_statement();
   ELSIF mode=3 THEN
    DROP TRIGGER a00_spin_mixed_history_identity_update_lane ON public.hand_history;
    CREATE TRIGGER a00_spin_mixed_history_identity_update_lane
      BEFORE UPDATE OF id,table_id,tournament_id,hand_number,players ON public.hand_history FOR EACH ROW
      EXECUTE FUNCTION public.fn_ca_serialize_legacy_settlement_receipt_statement();
   ELSIF mode=4 THEN
    EXECUTE $drift$CREATE OR REPLACE FUNCTION public.fn_ca_serialize_legacy_settlement_receipt_statement()
      RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp
      AS $body$ BEGIN RETURN NULL; END $body$$drift$;
   ELSIF mode=5 THEN
    -- Authentic service_role lacks schema CREATE. Grant only within this
    -- deliberately aborted fault subtransaction; the schema ACL is observed.
    GRANT CREATE ON SCHEMA public TO service_role;
    ALTER FUNCTION public.fn_ca_serialize_legacy_settlement_receipt_statement() OWNER TO service_role;
   ELSIF mode=6 THEN
    ALTER FUNCTION public.fn_ca_serialize_legacy_settlement_receipt_statement() SECURITY DEFINER;
   ELSE
    ALTER FUNCTION public.fn_ca_serialize_legacy_settlement_receipt_statement() SET search_path=public;
   END IF;
   IF public.sp_compact_hand_history(1,1,1) IS DISTINCT FROM
      '{"compacted":false,"reason":"update_trigger_present"}'::jsonb THEN
    RAISE EXCEPTION 'receipt lane compactor accepted altered binding %',mode; END IF;
   RAISE EXCEPTION USING ERRCODE='PZ913',MESSAGE='receipt lane altered binding refused';
  EXCEPTION WHEN SQLSTATE 'PZ913' THEN
   GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
   IF message<>'receipt lane altered binding refused' THEN RAISE; END IF;
  END;
 END LOOP;
 EXECUTE src.rollback_sql;
 IF pg_temp.receipt_lane_catalog() IS DISTINCT FROM before.catalog
    OR pg_temp.retention_database_state() IS DISTINCT FROM before.business
    OR pg_temp.receipt_lane_handler() IS NOT NULL THEN
  RAISE EXCEPTION 'receipt lane guarded rollback changed original consumers or rows'; END IF;
 INSERT INTO receipt_lane_cohort_result VALUES(before_reproduced,reverse_refusals);
END $controls$;
SELECT before_reproduced,reverse_prerequisite_refusals FROM receipt_lane_cohort_result \gset receipt_lane_
ROLLBACK;
DO $outer_observer$
DECLARE before record;
BEGIN
 SELECT * INTO STRICT before FROM receipt_lane_before;
 IF pg_temp.receipt_lane_catalog() IS DISTINCT FROM before.catalog
    OR pg_temp.retention_database_state() IS DISTINCT FROM before.business
    OR pg_temp.receipt_lane_handler() IS NOT NULL THEN
  RAISE EXCEPTION 'receipt lane outer rollback failed catalog, handler absence or full rows'; END IF;
END $outer_observer$;
SELECT jsonb_build_object('qualification','receipt_lane_catalog',
 'original_and_candidate_compactor_checked',true,'unrelated_update_trigger_refused',true,
 'altered_binding_refusals',7,'helper_authority_drift_refusals',2,'missing_preimage_refused',true,'replay_refused',true,
 'original_cohort_mismatch_reproduced',:'receipt_lane_before_reproduced'::boolean,
 'reverse_prerequisite_refusals',:'receipt_lane_reverse_prerequisite_refusals'::integer,
 'existing_function_metadata_preserved',true,'guarded_and_outer_rollback_verified',true,
 'business_rows_unchanged',true,'historical_rows_qualified',false,
 'financial_completion_qualified',false,'full_qualification',false);
