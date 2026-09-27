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
-- Explicit local negative: a real authoritative row changed after capture.
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL request.headers='{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}';
SET LOCAL request.method='POST';
SET LOCAL request.path='/rpc/fn_complete_first_archived_spin';
SET LOCAL ROLE service_role;
SELECT smarter_private.fn_smarter_data_api_pre_request();
UPDATE public.tournaments SET updated_at=updated_at+interval '1 microsecond'
 WHERE id='2aa4cba1-506f-426b-a1ba-d8e22e018533';
RESET ROLE;
CREATE TEMP TABLE archive_drift_before ON COMMIT DROP AS SELECT pg_temp.archive_financial_snapshot() value;
SET LOCAL ROLE service_role;
DO $$ DECLARE message text; BEGIN
 BEGIN
 PERFORM public.fn_complete_first_archived_spin(current_setting('archive_qualification.execution_uuid')::uuid,'8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5');
 RAISE EXCEPTION 'ARCHIVE_CHANGED_PREIMAGE_ACCEPTED';
 EXCEPTION WHEN SQLSTATE '40001' THEN GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
 IF message<>'ARCHIVED_SPIN_PREIMAGE_CHANGED' THEN RAISE; END IF;
 END;
END $$;
RESET ROLE;
DO $$ BEGIN IF pg_temp.archive_financial_snapshot() IS DISTINCT FROM (SELECT value FROM archive_drift_before) THEN
 RAISE EXCEPTION 'ARCHIVE_PREIMAGE_REFUSAL_MUTATED_INSIDE'; END IF; END $$;
ROLLBACK;
DO $$ BEGIN IF pg_temp.archive_financial_snapshot() IS DISTINCT FROM (SELECT value FROM archive_before) THEN
 RAISE EXCEPTION 'ARCHIVE_PREIMAGE_REFUSAL_MUTATED_AFTER'; END IF; END $$;
SELECT jsonb_build_object('execution',current_setting('archive_qualification.execution_uuid'),'stage','first_archived_preimage_drift',
 'changed_parent_refused',true,'whole_rows_unchanged_inside_and_after',true,'financial_qualified',false,'production_qualified',false);
