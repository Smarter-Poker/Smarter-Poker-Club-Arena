-- Isolated PostgreSQL qualification only. Never a production probe/migration.
-- Fault injection uses the existing allocator and the real canonical endpoint.
SET timezone='UTC';
SELECT set_config('archive_qualification.execution_uuid', :'execution_uuid', false);
DO $$ BEGIN
 IF session_user<>'fixture_bootstrap' OR current_user<>'fixture_bootstrap'
 OR current_database()<>'qual_spin_expiry_'||replace(current_setting('archive_qualification.execution_uuid'),'-','')
 OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
 OR current_setting('session_replication_role')<>'origin'
 OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 THEN
 RAISE EXCEPTION 'ARCHIVED_FIRST_PRIVATE_ALLOCATION_REQUIRED'; END IF;
END $$;
CREATE FUNCTION pg_temp.archive_failure_snapshot() RETURNS jsonb LANGUAGE plpgsql AS $snapshot$
DECLARE name text; part jsonb; result jsonb:='{}'; BEGIN
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','smarter_private','auth') AND c.relkind IN ('r','p'))>500 THEN RAISE EXCEPTION 'ARCHIVE_FIXTURE_RELATION_BOUND'; END IF;
 FOR name IN SELECT format('%I.%I',n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','smarter_private','auth') AND c.relkind IN ('r','p') ORDER BY n.nspname,c.relname LOOP
 EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb) FROM %s r',name) INTO part;
 IF jsonb_array_length(part)>1000 THEN RAISE EXCEPTION 'ARCHIVE_FIXTURE_ROW_BOUND'; END IF;
 result:=result||jsonb_build_object(name,part);
 END LOOP; RETURN result; END $snapshot$;
CREATE TEMP TABLE archive_failure_before ON COMMIT PRESERVE ROWS AS SELECT pg_temp.archive_failure_snapshot() value;
BEGIN;
DO $$ BEGIN IF transaction_timestamp()<'2026-10-05T07:00:00Z'::timestamptz OR transaction_timestamp()>='2026-10-12T07:00:00Z'::timestamptz THEN RAISE EXCEPTION 'ARCHIVE_RECOGNITION_PERIOD_CAPTURE_EXPIRED'; END IF; END $$;
CREATE FUNCTION pg_temp.archive_late_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $fault$
DECLARE previous numeric; present numeric; BEGIN
 IF NEW.tournament_id<>'2aa4cba1-506f-426b-a1ba-d8e22e018533'::uuid THEN
  RAISE EXCEPTION 'ARCHIVE_FAULT_UNEXPECTED_EVENT'; END IF;
 SELECT (r->>'chip_balance')::numeric INTO STRICT previous
 FROM pg_temp.archive_failure_before b CROSS JOIN LATERAL jsonb_array_elements(b.value->'public.club_members') r
 WHERE r->>'user_id'='aef849b8-2906-4dc0-b108-251710e76d3c' AND r->>'club_id'='a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
 SELECT chip_balance INTO STRICT present FROM public.club_members
 WHERE user_id='aef849b8-2906-4dc0-b108-251710e76d3c' AND club_id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
 IF present IS DISTINCT FROM previous+200
 OR NEW.cash_payout_count IS DISTINCT FROM 1 OR NEW.cash_payout_total IS DISTINCT FROM 200
 OR NOT EXISTS(SELECT 1 FROM smarter_private.spin_archived_first_admission
  WHERE tournament_id=NEW.tournament_id AND operation_id=current_setting('archive_qualification.execution_uuid')::uuid)
 OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=NEW.tournament_id AND status='COMPLETED')
 OR NOT EXISTS(SELECT 1 FROM public.tournament_launch_receipts WHERE tournament_id=NEW.tournament_id)
 OR EXISTS(SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id=NEW.tournament_id) THEN
  RAISE EXCEPTION 'ARCHIVE_LATE_FAULT_DID_NOT_REACH_REAL_CREDIT'; END IF;
 RAISE EXCEPTION 'ARCHIVE_QUALIFICATION_FAULT_AFTER_REAL_CREDIT' USING ERRCODE='PZ001';
END $fault$;
CREATE TRIGGER archive_qualification_late_fault BEFORE INSERT ON public.tournament_terminal_settlements
 FOR EACH ROW EXECUTE FUNCTION pg_temp.archive_late_fault();
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL request.headers='{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}';
SET LOCAL request.method='POST';
SET LOCAL request.path='/rpc/fn_complete_first_archived_spin';
SET LOCAL ROLE service_role;
SELECT smarter_private.fn_smarter_data_api_pre_request();
DO $$ DECLARE message text; BEGIN
 IF current_user<>'service_role' OR auth.role() IS DISTINCT FROM 'service_role' THEN
  RAISE EXCEPTION 'ARCHIVED_FIRST_SERVICE_CONTEXT_REQUIRED'; END IF;
 BEGIN
  PERFORM public.fn_complete_first_archived_spin(current_setting('archive_qualification.execution_uuid')::uuid,'8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5');
  RAISE EXCEPTION 'ARCHIVE_LATE_FAULT_WAS_NOT_REACHED';
 EXCEPTION WHEN SQLSTATE 'PZ001' THEN GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
  IF message<>'ARCHIVE_QUALIFICATION_FAULT_AFTER_REAL_CREDIT' THEN RAISE; END IF;
 END;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF pg_temp.archive_failure_snapshot() IS DISTINCT FROM (SELECT value FROM pg_temp.archive_failure_before) THEN
  RAISE EXCEPTION 'ARCHIVE_LATE_FAILURE_LEFT_PARTIAL_ROWS_INSIDE'; END IF;
END $$;
ROLLBACK;
DO $$ BEGIN
 IF pg_temp.archive_failure_snapshot() IS DISTINCT FROM (SELECT value FROM pg_temp.archive_failure_before) THEN
  RAISE EXCEPTION 'ARCHIVE_LATE_FAILURE_LEFT_PARTIAL_ROWS_AFTER'; END IF;
END $$;

-- Exercise the real deferred constraint, with no replacement owner or guard.
-- This privileged local malformed admission is not an API success scenario.
BEGIN;
DO $$ DECLARE message text; BEGIN
 BEGIN
  INSERT INTO smarter_private.spin_archived_first_admission
   (tournament_id,operation_id,lease_generation,owner_instance,source_sha256,original_fee_proof)
  VALUES('2aa4cba1-506f-426b-a1ba-d8e22e018533',current_setting('archive_qualification.execution_uuid')::uuid,
   current_setting('archive_qualification.execution_uuid')::uuid,'isolated-deferred-negative',
   '8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5',
   public.fn_ca_legacy_spin_original_fee_proof('2aa4cba1-506f-426b-a1ba-d8e22e018533'));
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'ARCHIVE_MALFORMED_ADMISSION_WAS_ACCEPTED';
 EXCEPTION WHEN SQLSTATE 'P0404' THEN GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
  IF message<>'ARCHIVED_SPIN_ATOMIC_TERMINAL_REQUIRED' THEN RAISE; END IF;
 END;
 IF pg_temp.archive_failure_snapshot() IS DISTINCT FROM (SELECT value FROM pg_temp.archive_failure_before) THEN
  RAISE EXCEPTION 'ARCHIVE_DEFERRED_FAILURE_LEFT_PARTIAL_ROWS_INSIDE'; END IF;
END $$;
ROLLBACK;
DO $$ BEGIN
 IF pg_temp.archive_failure_snapshot() IS DISTINCT FROM (SELECT value FROM pg_temp.archive_failure_before) THEN
  RAISE EXCEPTION 'ARCHIVE_DEFERRED_FAILURE_LEFT_PARTIAL_ROWS_AFTER'; END IF;
END $$;
SELECT jsonb_build_object('execution',current_setting('archive_qualification.execution_uuid'),'stage','first_archived_atomic_failures',
 'late_failure_after_real_credit',true,'deferred_admission_requires_terminal',true,
 'whole_rows_unchanged_inside_and_after',true,'sequence_rollback_claimed',false,
 'financial_qualified',false,'production_qualified',false);
