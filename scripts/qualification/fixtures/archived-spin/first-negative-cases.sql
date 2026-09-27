-- Isolated first-event connected diagnostic. It deliberately rolls back.
-- This is not historical settlement, a production probe, or complete qualification.
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
CREATE FUNCTION pg_temp.archive_financial_snapshot() RETURNS jsonb LANGUAGE plpgsql AS $snapshot$
DECLARE n text; part jsonb; result jsonb:='{}'; BEGIN
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','smarter_private','auth') AND c.relkind IN ('r','p'))>500 THEN RAISE EXCEPTION 'ARCHIVE_FIXTURE_RELATION_BOUND'; END IF;
 FOR n IN SELECT format('%I.%I',ns.nspname,c.relname) FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
 WHERE ns.nspname IN ('public','smarter_private','auth') AND c.relkind IN ('r','p') ORDER BY ns.nspname,c.relname LOOP
 EXECUTE format($query$SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM %s r$query$,n) INTO part;
 IF jsonb_array_length(part)>1000 THEN RAISE EXCEPTION 'ARCHIVE_FIXTURE_ROW_BOUND'; END IF;
 result:=result||jsonb_build_object(n,part);
 END LOOP; RETURN result; END $snapshot$;
CREATE FUNCTION pg_temp.archive_account_snapshot(document jsonb) RETURNS jsonb LANGUAGE plpgsql AS $accounts$
DECLARE name text; rows jsonb; result jsonb:='{}'; BEGIN
 FOREACH name IN ARRAY ARRAY['public.club_members','public.clubs','public.unions','public.union_wallets','public.spin_bonus_pools'] LOOP
 IF jsonb_typeof(document->name) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'ARCHIVE_ACCOUNT_RELATION_MISSING: %',name; END IF;
 SELECT coalesce(jsonb_agg(projected ORDER BY projected::text),'[]'::jsonb) INTO rows FROM (
 SELECT (SELECT jsonb_object_agg(k,v ORDER BY k) FROM jsonb_each(r) AS e(k,v)
 WHERE k IN ('id','user_id','club_id') OR k ~ '(balance|treasury|wallet|chip_pool|locked_chips|held_chips|credit_|diamonds|total_deposited|total_drawn|seeded_amount|surplus_returned|seed_returned_amount)') AS projected
 FROM jsonb_array_elements(document->name) r) q;
 result:=result||jsonb_build_object(name,rows);
 END LOOP; RETURN result; END $accounts$;
CREATE TEMP TABLE archive_before ON COMMIT PRESERVE ROWS AS SELECT pg_temp.archive_financial_snapshot() value;
-- Isolated negative cases only; every scenario rolls back.
BEGIN;
SET LOCAL request.jwt.claims='{"role":"anon"}';
SET LOCAL ROLE anon;
DO $$ DECLARE message text; BEGIN
 BEGIN
 PERFORM public.fn_complete_first_archived_spin(current_setting('archive_qualification.execution_uuid')::uuid,'8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5');
 RAISE EXCEPTION 'ARCHIVE_UNPRIVILEGED_CALL_ACCEPTED';
 EXCEPTION WHEN insufficient_privilege THEN GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
 IF position('permission denied for function fn_complete_first_archived_spin' IN message)=0 THEN RAISE; END IF;
 END;
END $$;
RESET ROLE;
DO $$ BEGIN IF pg_temp.archive_financial_snapshot() IS DISTINCT FROM (SELECT value FROM archive_before) THEN
 RAISE EXCEPTION 'ARCHIVE_REFUSAL_CHANGED_ROWS_INSIDE'; END IF; END $$;
ROLLBACK;
BEGIN;
SET LOCAL request.jwt.claims='{"role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$ DECLARE message text; BEGIN
 BEGIN
 PERFORM public.fn_complete_first_archived_spin(current_setting('archive_qualification.execution_uuid')::uuid,'8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5');
 RAISE EXCEPTION 'ARCHIVE_UNPRIVILEGED_CALL_ACCEPTED';
 EXCEPTION WHEN insufficient_privilege THEN GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
 IF position('permission denied for function fn_complete_first_archived_spin' IN message)=0 THEN RAISE; END IF;
 END;
END $$;
RESET ROLE;
DO $$ BEGIN IF pg_temp.archive_financial_snapshot() IS DISTINCT FROM (SELECT value FROM archive_before) THEN
 RAISE EXCEPTION 'ARCHIVE_REFUSAL_CHANGED_ROWS_INSIDE'; END IF; END $$;
ROLLBACK;
BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL request.headers='{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}';
SET LOCAL request.method='POST';
SET LOCAL request.path='/rpc/fn_complete_first_archived_spin';
SET LOCAL ROLE service_role;
SELECT smarter_private.fn_smarter_data_api_pre_request();
DO $$ DECLARE message text; BEGIN
 BEGIN
 PERFORM public.fn_complete_first_archived_spin(current_setting('archive_qualification.execution_uuid')::uuid,'wrong-original-source');
 RAISE EXCEPTION 'ARCHIVE_WRONG_SOURCE_ACCEPTED';
 EXCEPTION WHEN invalid_parameter_value THEN GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
 IF message<>'ARCHIVED_SPIN_SOURCE_REQUIRED' THEN RAISE; END IF;
 END;
 BEGIN
 PERFORM public.fn_complete_first_archived_spin(NULL,'8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5');
 RAISE EXCEPTION 'ARCHIVE_NULL_OPERATION_ACCEPTED';
 EXCEPTION WHEN invalid_parameter_value THEN GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
 IF message<>'ARCHIVED_SPIN_SOURCE_REQUIRED' THEN RAISE; END IF;
 END;
END $$;
RESET ROLE;
DO $$ BEGIN IF pg_temp.archive_financial_snapshot() IS DISTINCT FROM (SELECT value FROM archive_before) THEN
 RAISE EXCEPTION 'ARCHIVE_REFUSAL_CHANGED_ROWS_INSIDE'; END IF; END $$;
ROLLBACK;
BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL request.headers='{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}';
SET LOCAL request.method='POST';
SET LOCAL request.path='/rpc/fn_complete_first_archived_spin';
SET LOCAL ROLE service_role;
SELECT smarter_private.fn_smarter_data_api_pre_request();
DO $$ DECLARE claimed record; message text; competitor uuid:=md5(current_setting('archive_qualification.execution_uuid')||':competitor')::uuid; BEGIN
 SELECT * INTO claimed FROM public.claim_tournament_lease_v2('2aa4cba1-506f-426b-a1ba-d8e22e018533','service:archive-qualified-competitor','isolated-native-qualification',competitor,30);
 IF claimed.granted IS DISTINCT FROM true OR claimed.lease_generation IS DISTINCT FROM competitor THEN RAISE EXCEPTION 'ARCHIVE_COMPETING_LEASE_FIXTURE_NOT_CLAIMED'; END IF;
END $$;
RESET ROLE;
CREATE TEMP TABLE archive_competitor_lease ON COMMIT DROP AS SELECT to_jsonb(l) value FROM public.engine_tournament_leases l WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533';
SET LOCAL ROLE service_role;
DO $$ DECLARE message text; BEGIN
 BEGIN
 PERFORM public.fn_complete_first_archived_spin(current_setting('archive_qualification.execution_uuid')::uuid,'8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5');
 RAISE EXCEPTION 'ARCHIVE_COMPETING_LEASE_ACCEPTED';
 EXCEPTION WHEN serialization_failure THEN GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
 IF message<>'ARCHIVED_SPIN_COMPETING_OWNER' THEN RAISE; END IF;
 END;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF (SELECT count(*) FROM archive_competitor_lease)<>1
 OR (SELECT to_jsonb(l) FROM public.engine_tournament_leases l WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533') IS DISTINCT FROM (SELECT value FROM archive_competitor_lease)
 OR NOT EXISTS(SELECT 1 FROM public.engine_tournament_leases WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'
 AND instance_id='service:archive-qualified-competitor'
 AND lease_generation=md5(current_setting('archive_qualification.execution_uuid')||':competitor')::uuid)
 OR EXISTS(SELECT 1 FROM smarter_private.spin_archived_first_admission) THEN RAISE EXCEPTION 'ARCHIVE_COMPETING_LEASE_CUSTODY_LOST'; END IF;
 IF pg_temp.archive_financial_snapshot()-'public.engine_tournament_leases' IS DISTINCT FROM
 (SELECT value-'public.engine_tournament_leases' FROM archive_before) THEN RAISE EXCEPTION 'ARCHIVE_REFUSED_COMPETITOR_MUTATED_STATE'; END IF;
END $$;
ROLLBACK;
BEGIN;
SET LOCAL request.jwt.claims='{"role":"authenticated"}';
SET LOCAL ROLE service_role;
DO $$ DECLARE message text; BEGIN
 BEGIN
 PERFORM public.fn_complete_first_archived_spin(current_setting('archive_qualification.execution_uuid')::uuid,'8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5');
 RAISE EXCEPTION 'ARCHIVE_SERVICE_ACL_WRONG_JWT_ACCEPTED';
 EXCEPTION WHEN SQLSTATE '28000' THEN GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
 IF message<>'service authority required' THEN RAISE; END IF;
 END;
END $$;
RESET ROLE;
DO $$ BEGIN IF pg_temp.archive_financial_snapshot() IS DISTINCT FROM (SELECT value FROM archive_before) THEN
 RAISE EXCEPTION 'ARCHIVE_WRONG_JWT_MUTATED_INSIDE'; END IF; END $$;
ROLLBACK;
BEGIN;
-- Explicit isolated fault model through the actual immutable ABI guard.
DO $$ DECLARE message text; BEGIN
 BEGIN
 DELETE FROM public.ca_mtt_admission_contract;
 RAISE EXCEPTION 'ARCHIVE_ABI_AUTHORITY_DELETE_ACCEPTED';
 EXCEPTION WHEN SQLSTATE '55000' THEN GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
 IF message<>'MTT_ADMISSION_CONTRACT_IMMUTABLE' THEN RAISE; END IF;
 END;
 IF pg_temp.archive_financial_snapshot() IS DISTINCT FROM (SELECT value FROM archive_before) THEN
 RAISE EXCEPTION 'ARCHIVE_ABI_REFUSAL_MUTATED_INSIDE'; END IF;
END $$;
ROLLBACK;
BEGIN;
-- Explicit negative fixture, not reconstructed production maintenance history.
INSERT INTO public.engine_maintenance_break(id,phase,announced_at,enforce_freeze,ownership_token,reason,declared_by)
 VALUES(true,'last_hand',clock_timestamp()-interval '3 minutes',true,current_setting('archive_qualification.execution_uuid')::uuid,'Isolated qualification freeze','isolated-qualification');
DO $$ BEGIN IF public.fn_platform_frozen() IS DISTINCT FROM true THEN RAISE EXCEPTION 'ARCHIVE_FREEZE_FIXTURE_NOT_ACTIVE'; END IF; END $$;
CREATE TEMP TABLE archive_frozen_before ON COMMIT DROP AS SELECT pg_temp.archive_financial_snapshot() value;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL request.headers='{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}';
SET LOCAL request.method='POST';
SET LOCAL request.path='/rpc/fn_complete_first_archived_spin';
SET LOCAL ROLE service_role;
SELECT smarter_private.fn_smarter_data_api_pre_request();
DO $$ DECLARE message text; BEGIN
 BEGIN
 PERFORM public.fn_complete_first_archived_spin(current_setting('archive_qualification.execution_uuid')::uuid,'8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5');
 RAISE EXCEPTION 'ARCHIVE_FROZEN_COMPLETION_ACCEPTED';
 EXCEPTION WHEN SQLSTATE '55000' THEN GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
 IF message<>'PLATFORM_FROZEN' THEN RAISE; END IF;
 END;
END $$;
RESET ROLE;
DO $$ BEGIN IF pg_temp.archive_financial_snapshot() IS DISTINCT FROM (SELECT value FROM archive_frozen_before) THEN
 RAISE EXCEPTION 'ARCHIVE_FREEZE_REFUSAL_MUTATED_INSIDE'; END IF; END $$;
ROLLBACK;
DO $$ BEGIN IF pg_temp.archive_financial_snapshot() IS DISTINCT FROM (SELECT value FROM archive_before) THEN
 RAISE EXCEPTION 'ARCHIVE_NEGATIVE_CASES_CHANGED_ROWS'; END IF; END $$;
SELECT jsonb_build_object('execution',current_setting('archive_qualification.execution_uuid'),'stage','first_archived_negative_cases',
 'anon_denied',true,'authenticated_denied',true,'wrong_source_denied',true,'null_operation_denied',true,
 'actual_competing_lease_denied',true,'service_acl_wrong_jwt_denied',true,'abi_authority_immutable',true,'actual_freeze_denied',true,'economic_rows_unchanged',true,'financial_qualified',false,'production_qualified',false);
