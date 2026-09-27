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
BEGIN;
SET LOCAL timezone='UTC';
DO $$ BEGIN IF transaction_timestamp()<'2026-09-21T07:00:00Z'::timestamptz OR transaction_timestamp()>='2026-09-28T07:00:00Z'::timestamptz THEN RAISE EXCEPTION 'ARCHIVE_RECOGNITION_PERIOD_CAPTURE_EXPIRED'; END IF; END $$;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL request.headers='{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}';
SET LOCAL request.method='POST';
SET LOCAL request.path='/rpc/fn_complete_first_archived_spin';
SET LOCAL ROLE service_role;
DO $$ BEGIN IF current_user<>'service_role' OR auth.role() IS DISTINCT FROM 'service_role' THEN
 RAISE EXCEPTION 'ARCHIVED_FIRST_SERVICE_CONTEXT_REQUIRED'; END IF; END $$;
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT jsonb_build_object('execution',:'execution_uuid','stage','first_archived_terminal_before_rollback','event','2aa4cba1-506f-426b-a1ba-d8e22e018533',
 'response',public.fn_complete_first_archived_spin(:'execution_uuid'::uuid,'8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5'),
 'financial_qualified',false,'production_qualified',false);
-- Exercise deferred constraints under the actual service caller before readback.
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;
SELECT jsonb_build_object('execution',:'execution_uuid','stage','first_archived_state_before_rollback',
 'reserve_before',(SELECT value->'public.spin_reserve_ledger' FROM archive_before),
 'reserve_after',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM public.spin_reserve_ledger r),
 'ledger_before',(SELECT value->'public.chip_ledger' FROM archive_before),
 'ledger_after',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM public.chip_ledger r),
 'seats_before',(SELECT value->'public.table_seats' FROM archive_before),
 'seats_after',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM public.table_seats r),
 'primary_table',(SELECT to_jsonb(r) FROM public.tables r WHERE id='6eaddeaf-1511-4265-bb38-37811ae82ad9'),
 'history_count',(SELECT count(*) FROM public.hand_history),
 'atomic_commit_count',(SELECT count(*) FROM public.hand_atomic_commits),
 'accounts_before',pg_temp.archive_account_snapshot((SELECT value FROM archive_before)),
 'accounts_after',pg_temp.archive_account_snapshot(pg_temp.archive_financial_snapshot()),
 'custody_obligations',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY id),'[]'::jsonb) FROM public.accounting_tournament_fee_custody_obligations o WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'),
 'recognition_count',(SELECT count(*) FROM public.accounting_tournament_fee_recognitions WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'),
 'recognized_source_count',(SELECT count(*) FROM public.accounting_tournament_recognized_sources WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'),
 'rake_settlement_count',(SELECT count(*) FROM public.tournament_rake_settlements WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'),
 'wallet_delta',(SELECT chip_balance FROM public.club_members WHERE user_id='aef849b8-2906-4dc0-b108-251710e76d3c' AND club_id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4')-(SELECT (r->>'chip_balance')::numeric FROM archive_before b CROSS JOIN LATERAL jsonb_array_elements(b.value->'public.club_members') r WHERE r->>'user_id'='aef849b8-2906-4dc0-b108-251710e76d3c' AND r->>'club_id'='a41434bb-8d0c-400a-8f0d-e8b3d65afed4'),
 'players',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.tournament_players p WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'),
 'terminal',(SELECT to_jsonb(p) FROM public.tournament_terminal_settlements p WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'),
 'escrow',(SELECT to_jsonb(p) FROM public.tournament_escrow p WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'),
 'financial_qualified',false,'production_qualified',false);
ROLLBACK;
DO $$ BEGIN
 IF pg_temp.archive_financial_snapshot() IS DISTINCT FROM (SELECT value FROM archive_before) THEN
 RAISE EXCEPTION 'ARCHIVED_FIRST_ECONOMIC_ROLLBACK_FAILED'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.spin_archived_first_admission)
 OR EXISTS(SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533')
 OR EXISTS(SELECT 1 FROM public.engine_tournament_leases WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533') THEN
 RAISE EXCEPTION 'ARCHIVED_FIRST_DIAGNOSTIC_ROLLBACK_FAILED'; END IF;
END $$;
SELECT jsonb_build_object('execution',:'execution_uuid','stage','first_archived_after_rollback','economic_rows_unchanged',true,'admission_absent',true,'terminal_absent',true,'lease_absent',true,'financial_qualified',false,'production_qualified',false);
