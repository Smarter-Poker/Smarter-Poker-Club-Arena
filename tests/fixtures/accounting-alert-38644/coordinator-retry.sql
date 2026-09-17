\set ON_ERROR_STOP on
-- UNRUN: include inside regression.sql's rollback transaction, after its exact
-- 59-source assertions. Requires the complete candidate, actual service role,
-- and lifecycle template BEFORE the unrelated PNL hook seed. No production use.
-- Only the private coordinator clock dependency is substituted transactionally,
-- using the existing scheduler-fixture technique; its exact definition is restored.
-- No production source, freeze authority, agreement, original source or payment changes.
SET LOCAL timezone='UTC';
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='3s';
SET LOCAL app.weekly_accounting_attempt_budget='8';
SET LOCAL app.weekly_accounting_scheduler_started='';
SELECT pg_temp.alert38644_assert(current_user='postgres' AND session_user='postgres'
 AND current_database()='postgres' AND inet_server_addr() IS NULL
 AND current_setting('server_version_num')::integer>=170000
 AND current_setting('server_version_num')::integer<180000
 AND current_setting('session_replication_role')='origin'
 AND NOT EXISTS(SELECT 1 FROM public.engine_maintenance_break)
 AND NOT EXISTS(SELECT 1 FROM public.engine_maintenance_thaws),
 'coordinator clock seam requires isolated PG17 owner/socket database with no maintenance state');

-- Snapshot the installed authority BEFORE substituting its sole time input.
-- The service caller still reaches the actual SECURITY DEFINER coordinator;
-- its postgres owner can resolve this explicitly qualified session temp helper
-- despite SET search_path=public. No helper EXECUTE grant to service_role.
CREATE TEMP VIEW alert38644_current_function_authority AS
 SELECT p.oid,p.proowner,p.proacl,p.prosecdef,p.proconfig,md5(pg_get_functiondef(p.oid)) AS definition_md5
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN('public','auth') AND p.prokind IN('f','p');
CREATE TEMP TABLE alert38644_function_authority_before AS SELECT * FROM alert38644_current_function_authority;
CREATE TEMP TABLE alert38644_clock_original AS
 SELECT p.oid,pg_get_functiondef(p.oid) AS definition
 FROM pg_proc p WHERE p.oid='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;
SET LOCAL test.alert38644_clock='2026-09-14T09:20:00Z';
CREATE FUNCTION pg_temp.alert38644_clock() RETURNS timestamptz
 LANGUAGE sql VOLATILE AS $$SELECT current_setting('test.alert38644_clock')::timestamptz$$;
REVOKE ALL ON FUNCTION pg_temp.alert38644_clock() FROM PUBLIC,anon,authenticated,service_role;
DO $fixture_clock$
DECLARE original text;substituted text;installed text;
BEGIN
 SELECT definition INTO STRICT original FROM alert38644_clock_original;
 IF position('clock_timestamp()' IN original)=0
  OR position('pg_temp.alert38644_clock()' IN original)<>0
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure
   AND p.prosecdef AND pg_get_userbyid(p.proowner)='postgres'
   AND p.proconfig @> ARRAY['search_path=public']::text[])
 THEN RAISE EXCEPTION 'alert38644_clock_predecessor_changed';END IF;
 substituted:=replace(original,'clock_timestamp()','pg_temp.alert38644_clock()');
 EXECUTE substituted;
 SELECT pg_get_functiondef(oid) INTO STRICT installed FROM alert38644_clock_original;
 IF installed IS DISTINCT FROM substituted
  OR replace(installed,'pg_temp.alert38644_clock()','clock_timestamp()') IS DISTINCT FROM original
 THEN RAISE EXCEPTION 'alert38644_clock_substitution_changed_authority';END IF;
END $fixture_clock$;
SELECT pg_temp.alert38644_assert(pg_temp.alert38644_clock()=timestamptz '2026-09-14 09:20Z'
 AND pg_temp.alert38644_clock()>=public.fn_union_accounting_run_at('2026-09-14 07:00Z')
 AND extract(minute FROM pg_temp.alert38644_clock())<40
 AND public.fn_platform_frozen() IS FALSE,
 'coordinator uses a deterministic due pre-minute40 clock with the actual unfrozen authority');
SELECT pg_temp.alert38644_assert(NOT EXISTS(SELECT 1 FROM public.unions)
 AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs)
 AND NOT EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources)
 AND NOT EXISTS(SELECT 1 FROM public.agents WHERE NOT COALESCE(is_prepaid,false) AND credit_used>0)
 AND (SELECT count(*)=1 FROM public.rakeback_periods WHERE status='pending')
 AND NOT EXISTS(SELECT 1 FROM public.financial_alerts WHERE source='weekly_club_accounting'),
 'public dispatcher starts with only the exact disputed pending scope and no prior weekly alert');
SELECT pg_temp.alert38644_assert(
 has_function_privilege('service_role','public.fn_process_weekly_accounting(uuid)','EXECUTE')
 AND NOT has_function_privilege('service_role','public.fn_process_weekly_accounting_scope(uuid,uuid)','EXECUTE'),
 'actual service role can enter only the public coordinator, never its private scope implementation');

-- Full row snapshots, not just sums. Only the declared DSS treasury field is
-- omitted; its exact +1.00 fixture change is checked separately. The one later
-- synthetic malformed source/receipt/work entry is excluded by its exact ID.
-- All original source attempts, original evidence and payment artifacts remain.
CREATE FUNCTION pg_temp.alert38644_preserved_state() RETURNS jsonb
LANGUAGE plpgsql STABLE AS $snapshot$
DECLARE relation_name text;predicate text;rows jsonb;result jsonb:='{}';
BEGIN
 FOR relation_name IN SELECT unnest(ARRAY[
  'rake_records','rake_attributions','rake_distribution_legs','agent_commissions',
  'rakeback_periods','rakeback_period_payouts','rakeback_daily_user','rakeback_daily_state',
  'wallet_transactions','wallet_credit_idempotency','chip_ledger','chip_transactions',
  'club_members','agents','club_wallets','club_wallet_transactions','wallets',
  'union_wallets','union_wallet_transactions','credit_invoices','credit_payments',
  'agent_commission_settlements','ca_settlements','union_settlement_rounds',
  'settlement_periods','settlement_invoices','accounting_invoice_deliveries',
  'accounting_cash_accrual_batches','accounting_cash_bank_receipts','accounting_cash_rake_sources',
  'accounting_rakeback_period_calculations','rakeback_stats_applied',
  'accounting_period_recompute_requests','accounting_agreement_history',
  'accounting_routed_settlement_runs','accounting_cash_source_receipts','accounting_cash_source_work'
 ]) LOOP
  predicate:=CASE WHEN relation_name='rake_records'
   THEN ' WHERE id<>''38644000-0000-4000-8000-000000000001''::uuid'
   WHEN relation_name IN('accounting_cash_source_receipts','accounting_cash_source_work')
   THEN ' WHERE rake_record_id<>''38644000-0000-4000-8000-000000000001''::uuid' ELSE '' END;
  EXECUTE format('SELECT COALESCE(jsonb_agg(v ORDER BY v::text),''[]''::jsonb)
   FROM (SELECT to_jsonb(t) AS v FROM public.%I t%s)s',relation_name,predicate) INTO rows;
  result:=result||jsonb_build_object(relation_name,rows);
 END LOOP;
 SELECT COALESCE(jsonb_agg(v ORDER BY v::text),'[]'::jsonb) INTO rows
  FROM (SELECT CASE WHEN c.id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid
   THEN to_jsonb(c)-'chip_treasury' ELSE to_jsonb(c) END AS v FROM public.clubs c)s;
 RETURN result||jsonb_build_object('clubs_except_declared_treasury',rows,
  'original_evidence',(SELECT document FROM alert38644_evidence));
END $snapshot$;
CREATE TEMP TABLE alert38644_preserved_before AS SELECT pg_temp.alert38644_preserved_state() AS value;
CREATE TEMP TABLE alert38644_treasury_before AS
 SELECT chip_treasury FROM public.clubs WHERE id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
CREATE TEMP TABLE alert38644_scope_before AS
 SELECT public.fn_cash_source_refusals_for_period(NULL,'2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',
  '2026-09-07 07:00Z','2026-09-14 07:00Z') AS value;
SELECT pg_temp.alert38644_assert((SELECT value=jsonb_build_object('status','blocked','count',59,
 'sources',(SELECT jsonb_agg(jsonb_build_object('rake_record_id',r.rake_record_id,
  'reason','cash_source_legacy_unverified','scope',r.scope) ORDER BY r.rake_record_id)
  FROM public.accounting_cash_source_receipts r JOIN public.accounting_cash_source_work w ON w.receipt_id=r.id
  JOIN alert38644_raw raw ON raw.id=r.rake_record_id))
 FROM alert38644_scope_before),'actual source reader returns exactly the original59 latest durable refusals');

CREATE TEMP VIEW alert38644_weekly_alerts AS
 SELECT a.* FROM public.financial_alerts a WHERE a.source='weekly_club_accounting'
  AND a.context->>'club_id'='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
  AND (a.context->>'period_start')::timestamptz='2026-09-07 07:00Z'
  AND (a.context->>'period_end')::timestamptz='2026-09-14 07:00Z';
CREATE TEMP TABLE alert38644_coordinator_calls(
 stage text PRIMARY KEY,observation jsonb NOT NULL,run_row jsonb,identity jsonb,alerts jsonb
);
CREATE FUNCTION pg_temp.alert38644_check_coordinator(
 p_stage text,p_attempt integer,p_source_check jsonb,p_alert_count integer)
RETURNS void LANGUAGE plpgsql AS $check$
DECLARE observation jsonb;result jsonb;failure jsonb;v_run_row jsonb;v_alerts jsonb;
BEGIN
 SELECT c.observation INTO STRICT observation FROM alert38644_coordinator_calls c WHERE stage=p_stage;
 result:=observation->'result';
 PERFORM pg_temp.alert38644_assert((observation->>'caller'='service_role'
  AND result->'success'='false'::jsonb AND result->'checked'='1'::jsonb
  AND result->'failed'='1'::jsonb AND result->'visited_scopes'='1'::jsonb
  AND result->'more_remaining'='false'::jsonb AND NOT(result ? 'skipped')
  AND jsonb_array_length(result->'detail')=1
  AND result->'detail'->0->>'club_id'='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
  AND (result->'detail'->0->>'period_start')::timestamptz='2026-09-07 07:00Z'
  AND (result->'detail'->0->>'period_end')::timestamptz='2026-09-14 07:00Z') IS TRUE,
  p_stage||': actual public service coordinator attempts exactly the historical club week; skips never pass');
 failure:=result->'detail'->0->'result';
 PERFORM pg_temp.alert38644_assert((failure->'success'='false'::jsonb
  AND failure->>'error'='weekly_accounting_calculation_incomplete' AND failure->>'sqlstate'='P0001'
  AND (failure->>'detail')::jsonb=jsonb_build_object('success',false,'accounting_version',3,
   'union_id',NULL,'club_id','2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',
   'period_start','2026-09-07T07:00:00+00:00','period_end','2026-09-14T07:00:00+00:00','clubs',0,
   'problems',jsonb_build_array(jsonb_build_object('reason','cash_source_refusals_pending',
    'source_check',p_source_check)))) IS TRUE,p_stage||': exact real preparation refusal is retained');
 SELECT to_jsonb(q) INTO STRICT v_run_row FROM public.union_accounting_runs q
  WHERE scope_kind='club' AND scope_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
   AND period_start='2026-09-07 07:00Z' AND period_end='2026-09-14 07:00Z';
 PERFORM pg_temp.alert38644_assert((v_run_row->>'status'='failed'
  AND v_run_row->'attempts'=to_jsonb(p_attempt) AND v_run_row->'result'=failure
  AND (SELECT count(*)=1 FROM public.union_accounting_runs)) IS TRUE,
  p_stage||': exactly one durable failed run retains the expected attempt and returned result');
 SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) INTO v_alerts FROM alert38644_weekly_alerts a;
 PERFORM pg_temp.alert38644_assert(jsonb_array_length(v_alerts)=p_alert_count
  AND (SELECT count(*)=p_alert_count FROM public.financial_alerts WHERE source='weekly_club_accounting')
  AND EXISTS(SELECT 1 FROM alert38644_weekly_alerts a WHERE a.context->'result'=failure AND a.resolved IS FALSE),
  p_stage||': exact full financial-original alert is durably stored and remains unresolved');
 PERFORM pg_temp.alert38644_assert(pg_temp.alert38644_preserved_state()=(SELECT value FROM alert38644_preserved_before),
  p_stage||': all original evidence, source attempts, memberships, liabilities and payment records remain unchanged');
 PERFORM pg_temp.alert38644_assert((SELECT c.chip_treasury IS NOT DISTINCT FROM
  CASE WHEN p_attempt=1 THEN b.chip_treasury ELSE COALESCE(b.chip_treasury,0)+1.00 END
  FROM public.clubs c CROSS JOIN alert38644_treasury_before b
  WHERE c.id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'),
  p_stage||': coordinator cannot change even the explicitly perturbed treasury');
 UPDATE alert38644_coordinator_calls SET run_row=v_run_row,
  identity=public.fn_accounting_failure_identity(failure),alerts=v_alerts WHERE stage=p_stage;
END $check$;

-- The clock seam must preserve the production minute45 gate: the actual public
-- service entry refuses this window without creating a run, alert or money row.
SET LOCAL test.alert38644_clock='2026-09-14T09:45:00Z';
SET LOCAL ROLE service_role;
SELECT jsonb_build_object('caller',current_user,'result',public.fn_process_weekly_accounting(NULL)) AS observation
 \gset alert38644_closed_window_
RESET ROLE;
SELECT pg_temp.alert38644_assert(:'alert38644_closed_window_observation'::jsonb=jsonb_build_object(
 'caller','service_role','result',jsonb_build_object('success',true,'skipped',true,'reason','maintenance_window'))
 AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs)
 AND NOT EXISTS(SELECT 1 FROM public.financial_alerts WHERE source='weekly_club_accounting')
 AND pg_temp.alert38644_preserved_state()=(SELECT value FROM alert38644_preserved_before),
 'actual minute45 coordinator refusal preserves all original state and creates no run or alert');
SET LOCAL test.alert38644_clock='2026-09-14T09:20:00Z';

-- Actual role transition: caller is captured outside the SECURITY DEFINER
-- invocation. No private EXECUTE grant or dispatch/calculation replacement.
SET LOCAL ROLE service_role;
SELECT jsonb_build_object('caller',current_user,'result',public.fn_process_weekly_accounting(NULL)) AS observation
 \gset alert38644_first_
RESET ROLE;
INSERT INTO alert38644_coordinator_calls(stage,observation) VALUES('first',:'alert38644_first_observation'::jsonb);
SELECT pg_temp.alert38644_check_coordinator('first',1,(SELECT value FROM alert38644_scope_before),1);

-- Opening-state perturbation ONLY, in this disposable rollback fixture.
-- Normal treasury writes create autoledger/updated_at side effects. Suppress
-- seed triggers for this ONE update, then restore origin before any caller.
SET LOCAL session_replication_role=replica;
UPDATE public.clubs SET chip_treasury=COALESCE(chip_treasury,0)+1.00
 WHERE id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
SET LOCAL session_replication_role=origin;
SELECT pg_temp.alert38644_assert(current_setting('session_replication_role')='origin'
 AND (SELECT c.chip_treasury=COALESCE(b.chip_treasury,0)+1.00 FROM public.clubs c
  CROSS JOIN alert38644_treasury_before b WHERE c.id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3')
 AND pg_temp.alert38644_preserved_state()=(SELECT value FROM alert38644_preserved_before),
 'between first and retry only the declared fixture treasury changed by exactly1.00; no journal or timestamp changed');
SET LOCAL ROLE service_role;
SELECT jsonb_build_object('caller',current_user,'result',public.fn_process_weekly_accounting(NULL)) AS observation
 \gset alert38644_treasury_
RESET ROLE;
INSERT INTO alert38644_coordinator_calls(stage,observation) VALUES('treasury_retry',:'alert38644_treasury_observation'::jsonb);
SELECT pg_temp.alert38644_check_coordinator('treasury_retry',2,(SELECT value FROM alert38644_scope_before),1);
SELECT pg_temp.alert38644_assert((SELECT a.identity=b.identity AND a.alerts=b.alerts
 AND a.run_row-'attempts'-'started_at'-'finished_at'-'last_scheduler_visit_at'
  =b.run_row-'attempts'-'started_at'-'finished_at'-'last_scheduler_visit_at'
 FROM alert38644_coordinator_calls a CROSS JOIN alert38644_coordinator_calls b
 WHERE a.stage='first' AND b.stage='treasury_retry'),
 'treasury-only retry preserves exact failure identity, original alert UUID/full row and durable run identity');

-- Materially changed refusal: one NEW explicitly synthetic malformed source.
-- It is not a missing historical contributor, bank receipt or commercial term.
SELECT pg_temp.alert38644_assert(NOT EXISTS(SELECT 1 FROM public.rake_records
 WHERE id='38644000-0000-4000-8000-000000000001'),'synthetic fault ID must be absent');
SET LOCAL session_replication_role=replica;
INSERT INTO public.rake_records(id,hand_id,table_id,club_id,rake_amount,created_at,is_tournament,tournament_id,source,metadata)
 VALUES('38644000-0000-4000-8000-000000000001',NULL,'02a1adb6-7e4a-49c8-af0a-757265685ca8',
  '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',1.00,'2026-09-09 06:03:00Z',false,NULL,
  'fixture_38644_changed_refusal','{"synthetic":true,"purpose":"additional malformed-source refusal; no historic attribution"}');
SET LOCAL session_replication_role=origin;
CREATE TEMP TABLE alert38644_synthetic_outcome AS
 SELECT public.fn_process_cash_accounting_source('38644000-0000-4000-8000-000000000001') AS value;
SELECT pg_temp.alert38644_assert((SELECT count(*)=1 AND bool_and((r.attempt=1 AND w.attempts=1
 AND r.status='blocked' AND r.reason='cash_source_identity_or_amount_invalid'
 AND r.rake_record_id='38644000-0000-4000-8000-000000000001'::uuid
 AND r.scope->>'kind'='unknown' AND r.result=o.value AND o.value->'credits'='[]'::jsonb
 AND o.value->'recorded'='true'::jsonb AND o.value->'hand_id'='null'::jsonb
 AND raw.hand_id IS NULL AND o.value->>'rake_record_id'=raw.id::text
 AND o.value->'earned_at'=to_jsonb(raw.created_at) AND r.earned_at=raw.created_at
 AND o.value->>'source_fingerprint'=r.source_fingerprint AND o.value->'scope'=r.scope
 AND o.value->>'reason'=r.reason AND o.value->>'status'=r.status
 AND w.status=r.status AND r.source_fingerprint=w.source_fingerprint) IS TRUE)
 FROM alert38644_synthetic_outcome o JOIN public.accounting_cash_source_receipts r ON r.id::text=o.value->>'receipt_id'
 JOIN public.accounting_cash_source_work w ON w.receipt_id=r.id AND w.rake_record_id=r.rake_record_id
 JOIN public.rake_records raw ON raw.id=r.rake_record_id),
 'material change is a real persisted refusal for one synthetic source, not an edited original or fabricated response');
CREATE TEMP TABLE alert38644_scope_changed AS
 SELECT public.fn_cash_source_refusals_for_period(NULL,'2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',
  '2026-09-07 07:00Z','2026-09-14 07:00Z') AS value;
SELECT pg_temp.alert38644_assert((SELECT changed.value=jsonb_build_object('status','blocked','count',60,
 'sources',(SELECT jsonb_agg(expected.value ORDER BY expected.value->>'rake_record_id') FROM (
  SELECT s AS value FROM alert38644_scope_before b CROSS JOIN LATERAL jsonb_array_elements(b.value->'sources')s
  UNION ALL SELECT jsonb_build_object('rake_record_id',r.rake_record_id,
   'reason','cash_source_identity_or_amount_invalid','scope',r.scope)
   FROM public.accounting_cash_source_receipts r JOIN public.accounting_cash_source_work w ON w.receipt_id=r.id
   WHERE w.rake_record_id='38644000-0000-4000-8000-000000000001')expected))
 FROM alert38644_scope_changed changed),'changed projection equals exactly the original59 plus the complete new persisted refusal');
CREATE TEMP TABLE alert38644_synthetic_snapshot AS
 SELECT jsonb_build_object('raw',(SELECT to_jsonb(r) FROM public.rake_records r WHERE id='38644000-0000-4000-8000-000000000001'),
 'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.accounting_cash_source_receipts r WHERE rake_record_id='38644000-0000-4000-8000-000000000001'),
 'work',(SELECT to_jsonb(w) FROM public.accounting_cash_source_work w WHERE rake_record_id='38644000-0000-4000-8000-000000000001')) AS value;
SET LOCAL ROLE service_role;
SELECT jsonb_build_object('caller',current_user,'result',public.fn_process_weekly_accounting(NULL)) AS observation
 \gset alert38644_changed_
RESET ROLE;
INSERT INTO alert38644_coordinator_calls(stage,observation) VALUES('changed',:'alert38644_changed_observation'::jsonb);
SELECT pg_temp.alert38644_check_coordinator('changed',3,(SELECT value FROM alert38644_scope_changed),2);
SELECT pg_temp.alert38644_assert((SELECT a.identity IS DISTINCT FROM b.identity
 AND jsonb_array_length(b.alerts)=2
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(b.alerts)s WHERE s=a.alerts->0)
 AND (SELECT count(DISTINCT s->>'id')=2 FROM jsonb_array_elements(b.alerts)s)
 FROM alert38644_coordinator_calls a CROSS JOIN alert38644_coordinator_calls b WHERE a.stage='first' AND b.stage='changed'),
 'material refusal gets a distinct failure identity and new financial-original UUID, retaining the first complete alert row');
SET LOCAL ROLE service_role;
SELECT jsonb_build_object('caller',current_user,'result',public.fn_process_weekly_accounting(NULL)) AS observation
 \gset alert38644_changed_retry_
RESET ROLE;
INSERT INTO alert38644_coordinator_calls(stage,observation) VALUES('changed_retry',:'alert38644_changed_retry_observation'::jsonb);
SELECT pg_temp.alert38644_check_coordinator('changed_retry',4,(SELECT value FROM alert38644_scope_changed),2);
SELECT pg_temp.alert38644_assert((SELECT a.identity=b.identity AND a.alerts=b.alerts
 FROM alert38644_coordinator_calls a CROSS JOIN alert38644_coordinator_calls b WHERE a.stage='changed' AND b.stage='changed_retry'),
 'unchanged material refusal retry preserves both financial-original UUIDs and complete rows');
SELECT pg_temp.alert38644_assert((SELECT value=jsonb_build_object(
 'raw',(SELECT to_jsonb(r) FROM public.rake_records r WHERE id='38644000-0000-4000-8000-000000000001'),
 'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.accounting_cash_source_receipts r WHERE rake_record_id='38644000-0000-4000-8000-000000000001'),
 'work',(SELECT to_jsonb(w) FROM public.accounting_cash_source_work w WHERE rake_record_id='38644000-0000-4000-8000-000000000001'))
 FROM alert38644_synthetic_snapshot),'coordinator leaves even the added synthetic source and its original refusal receipt unchanged');
-- Restore the original exact definition while still inside the rollback
-- transaction, then compare every public/auth authority field in both directions.
DO $restore_clock$
DECLARE original text;installed text;
BEGIN
 SELECT definition INTO STRICT original FROM alert38644_clock_original;
 EXECUTE original;
 SELECT pg_get_functiondef(oid) INTO STRICT installed FROM alert38644_clock_original;
 IF installed IS DISTINCT FROM original THEN RAISE EXCEPTION 'alert38644_clock_restore_mismatch';END IF;
END $restore_clock$;
SELECT pg_temp.alert38644_assert((SELECT count(*)=4 FROM alert38644_coordinator_calls)
 AND NOT EXISTS((SELECT * FROM alert38644_function_authority_before EXCEPT SELECT * FROM alert38644_current_function_authority)
 UNION ALL(SELECT * FROM alert38644_current_function_authority EXCEPT SELECT * FROM alert38644_function_authority_before))
 AND current_user='postgres' AND current_setting('session_replication_role')='origin',
 'all four actual coordinator calls preserve every public/auth function definition, owner, ACL and security setting');
-- Durable output is captured in historical-conflict.log before outer rollback.
SELECT stage,observation,run_row,identity,alerts FROM alert38644_coordinator_calls ORDER BY (run_row->>'attempts')::integer;
SELECT 'BOUNDARY: financial-original identity verified by assertions when run; downstream drift-incident aggregation is not changed or qualified by this case.' AS scope;
