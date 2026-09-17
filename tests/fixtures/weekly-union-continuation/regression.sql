\set ON_ERROR_STOP on
-- UNRUN. Apply load.sql first. No statement here is production repair.
-- Actual coordinator/cascade/routed/period/conservation bodies are exercised;
-- inherited PNL/calculator and exact-zero R1 seams are documented in README.

BEGIN;
INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES(u(1001),'2026-08-24 07:00Z','2026-08-31 07:00Z','2026-08-31 09:00Z','failed',1,
 '{"success":false,"error":"fixture_interrupted_book"}');
CREATE TEMP TABLE first_attempt AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'success'='true' AND r->>'checked'='1' AND r->>'failed'='0'
 AND r->>'more_remaining'='true' AND r->'detail'->0->>'union_id'=u(1001)::text
 AND (r->'detail'->0->>'period_start')::timestamptz='2026-08-24 07:00Z' FROM first_attempt)
 AND (SELECT status='complete' AND attempts=2 FROM union_accounting_runs WHERE union_id=u(1001)),
 'old failed union week succeeds on the last shared attempt and durably remains the known start');
CREATE TEMP TABLE second_attempt AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='1' AND r->>'failed'='0'
 AND (r->'detail'->0->>'period_start')::timestamptz='2026-08-31 07:00Z' FROM second_attempt)
 AND NOT EXISTS(SELECT 1 FROM union_accounting_runs WHERE union_id=u(1001) AND period_start='2026-09-07 07:00Z'),
 'after failed-to-complete transition the next tick processes the missing middle week before the current week');
CREATE TEMP TABLE third_attempt AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='1' AND r->>'failed'='0'
 AND (r->'detail'->0->>'period_start')::timestamptz='2026-09-07 07:00Z' FROM third_attempt)
 AND (SELECT count(*)=3 AND bool_and(status='complete') AND sum(attempts)=4 FROM union_accounting_runs WHERE union_id=u(1001)),
 'three bounded invocations complete all known union weeks in chronological order');
SELECT assert_true((SELECT count(*)=6 AND bool_and((result->>'success'='true' AND result->'amount'='0'::jsonb) IS TRUE)
 FROM accounting_routed_settlement_runs WHERE scope_kind='union' AND scope_id=u(1001))
 AND (SELECT count(*)=12 FROM union_settlement_rounds WHERE union_id=u(1001))
 AND (SELECT count(*)=3 AND bool_and(status='settled') FROM settlement_periods WHERE union_id=u(1001) AND club_id IS NULL)
 AND (SELECT chip_balance=1000 AND rake_wallet=0 FROM union_wallets WHERE union_id=u(1001))
 AND NOT EXISTS(SELECT 1 FROM chip_ledger WHERE union_id=u(1001)),
 'actual zero routed receipts and settled period objects accompany completion without a wallet payment');
CREATE TEMP TABLE before_replay AS SELECT test_union_continuation_snapshot(u(1001)) AS value;
CREATE TEMP TABLE replay AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'success'='true' AND r->>'checked'='0' AND r->>'failed'='0' FROM replay)
 AND test_union_continuation_snapshot(u(1001))=(SELECT value FROM before_replay),
 'complete-history replay does not repeat financial attempts, routed receipts, invoices or deliveries');
SELECT assert_true(current_setting('app.weekly_accounting_attempt_budget')='1'
 AND COALESCE(current_setting('app.weekly_accounting_scheduler_started',true),'')='',
 'all-scope recursive continuation preserves the inherited total budget and restores its deadline setting');
ROLLBACK;

BEGIN;
-- First create a real successful predecessor through the actual coordinator.
-- Then advance only its clock; no failed row is available for discovery.
SET LOCAL test.clock='2026-08-31T09:20:00Z';
CREATE TEMP TABLE completed_predecessor AS SELECT fn_process_weekly_accounting(u(1001)) AS r;
SELECT assert_true((SELECT r->>'checked'='1' AND r->>'failed'='0' FROM completed_predecessor)
 AND (SELECT status='complete' AND result->>'accounting_version'='3' FROM union_accounting_runs WHERE union_id=u(1001)),
 'a latest prior complete version 3 book is produced by the real coordinator');
SET LOCAL test.clock='2026-09-14T09:20:00Z';
CREATE TEMP TABLE after_missed_tick AS SELECT fn_process_weekly_accounting(u(1001)) AS r;
SELECT assert_true((SELECT r->>'checked'='1' AND r->>'failed'='0'
 AND (r->'detail'->0->>'period_start')::timestamptz='2026-08-31 07:00Z' FROM after_missed_tick)
 AND NOT EXISTS(SELECT 1 FROM union_accounting_runs WHERE union_id=u(1001) AND period_start='2026-09-07 07:00Z'),
 'exact-scope continuation uses a completed predecessor and cannot jump over an unattempted week');
CREATE TEMP TABLE after_middle AS SELECT fn_process_weekly_accounting(u(1001)) AS r;
SELECT assert_true((SELECT r->>'checked'='1' AND r->>'failed'='0'
 AND (r->'detail'->0->>'period_start')::timestamptz='2026-09-07 07:00Z' FROM after_middle),
 'exact-scope replay resumes the next chronological week after the shared cap');
ROLLBACK;

BEGIN;
SET LOCAL test.clock='2026-08-31T09:20:00Z';
SELECT assert_true(fn_process_weekly_accounting(u(1001))->>'failed'='0','prepare actual known completed start for gap test');
SET LOCAL test.clock='2026-09-14T09:20:00Z';
-- Fixture-only floor change makes a later success with a gap reproducible.
INSERT INTO union_settlement_floor VALUES(u(1001),'2026-09-07 07:00Z');
SELECT assert_true(fn_process_weekly_accounting(u(1001))->>'failed'='0','explicit synthetic floor permits the later observed successful book');
DELETE FROM union_settlement_floor WHERE union_id=u(1001);
CREATE TEMP TABLE current_book AS SELECT to_jsonb(q) AS value FROM union_accounting_runs q WHERE union_id=u(1001) AND period_start='2026-09-07 07:00Z';
CREATE TEMP TABLE fill_known_gap AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='1' AND r->>'failed'='0'
 AND (r->'detail'->0->>'period_start')::timestamptz='2026-08-31 07:00Z' FROM fill_known_gap)
 AND (SELECT count(*)=3 AND bool_and(status='complete') FROM union_accounting_runs WHERE union_id=u(1001)),
 'a successful current book cannot hide the missing week after an older known version 3 start');
SELECT assert_true((SELECT to_jsonb(q)-'last_scheduler_visit_at'=(SELECT value-'last_scheduler_visit_at' FROM current_book)
 FROM union_accounting_runs q WHERE union_id=u(1001) AND period_start='2026-09-07 07:00Z'),
 'gap completion preserves the later successful result and its original attempt facts');
ROLLBACK;

BEGIN;
INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES(u(1001),'2026-08-24 07:00Z','2026-08-31 07:00Z','2026-08-31 09:00Z','failed',1,'{"success":false}');
SET LOCAL test.zero_r1_blocked='true';
CREATE TEMP TABLE refused_one AS SELECT fn_process_weekly_accounting(NULL) AS r;
CREATE TEMP TABLE refused_two AS SELECT fn_process_weekly_accounting(u(1001)) AS r;
SELECT assert_true((SELECT r->>'failed'='1' AND (r->'detail'->0->>'period_start')::timestamptz='2026-08-24 07:00Z' FROM refused_one)
 AND (SELECT r->>'failed'='1' AND (r->'detail'->0->>'period_start')::timestamptz='2026-08-24 07:00Z' FROM refused_two)
 AND (SELECT count(*)=1 AND bool_and(status='failed') FROM union_accounting_runs WHERE union_id=u(1001))
 AND (SELECT count(*)=1 FROM financial_alerts WHERE context->>'union_id'=u(1001)::text),
 'an unchanged oldest failure remains first, prevents later attempts and keeps one stable alert');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM accounting_routed_settlement_runs WHERE scope_kind='union' AND scope_id=u(1001))
 AND NOT EXISTS(SELECT 1 FROM settlement_periods WHERE union_id=u(1001)),
 'refused predecessor cannot fabricate routed completion or a settled period');
ROLLBACK;

BEGIN;
INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES(u(1001),'2026-08-24 07:00Z','2026-08-31 07:00Z','2026-08-31 09:00Z','failed',7,'{"success":false,"preserved":true}');
CREATE TEMP TABLE excluded_run AS SELECT to_jsonb(q) AS value FROM union_accounting_runs q WHERE union_id=u(1001);
INSERT INTO union_settlement_floor VALUES(u(1001),'2026-09-07 07:00Z');
CREATE TEMP TABLE explicit_floor AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='1' AND r->>'failed'='0'
 AND (r->'detail'->0->>'period_start')::timestamptz='2026-09-07 07:00Z' FROM explicit_floor)
 AND (SELECT to_jsonb(q)=(SELECT value FROM excluded_run) FROM union_accounting_runs q WHERE union_id=u(1001) AND period_start='2026-08-24 07:00Z')
 AND NOT EXISTS(SELECT 1 FROM union_accounting_runs WHERE union_id=u(1001) AND period_start='2026-08-31 07:00Z'),
 'explicit clean floor still excludes old unresolved history and preserves its original row');
ROLLBACK;

BEGIN;
INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES(u(1001),'2026-08-24 07:00Z','2026-08-31 07:00Z','2026-08-31 09:00Z','complete',1,'{"success":true,"accounting_version":2}');
CREATE TEMP TABLE legacy_complete AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='1' AND r->>'failed'='0'
 AND (r->'detail'->0->>'period_start')::timestamptz='2026-09-07 07:00Z' FROM legacy_complete)
 AND NOT EXISTS(SELECT 1 FROM union_accounting_runs WHERE union_id=u(1001) AND period_start='2026-08-31 07:00Z'),
 'legacy completion does not create a new historical authorization boundary');
ROLLBACK;

BEGIN;
CREATE TEMP TABLE unknown_start AS SELECT fn_process_weekly_accounting(u(1001)) AS r;
SELECT assert_true((SELECT r->>'checked'='1' AND r->>'failed'='0'
 AND (r->'detail'->0->>'period_start')::timestamptz='2026-09-07 07:00Z' FROM unknown_start)
 AND (SELECT count(*)=1 FROM union_accounting_runs WHERE union_id=u(1001)),
 'no recorded starting run preserves the existing just-closed-week behavior');
ROLLBACK;

BEGIN;
SET LOCAL test.is_engine='false';
SELECT assert_true(refuses('SELECT fn_process_weekly_accounting(NULL)','not_authorised')
 AND refuses('SELECT fn_process_weekly_accounting_scope(u(1001),NULL)','not_authorised'),
 'continuation changes do not widen engine authorization');
ROLLBACK;
SELECT assert_true(NOT has_function_privilege('anon','fn_process_weekly_accounting_scope(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','fn_process_weekly_accounting_scope(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('service_role','fn_process_weekly_accounting_scope(uuid,uuid)','EXECUTE'),
 'the existing implementation remains private after successor and fixture clock control');
