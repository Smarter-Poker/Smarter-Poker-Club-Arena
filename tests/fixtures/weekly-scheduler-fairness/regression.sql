\set ON_ERROR_STOP on
-- UNRUN: apply load.sql first in an isolated protected fixture database.
SET timezone='UTC';
SET test.clock='2026-09-14T08:30:00Z';
CREATE TEMP TABLE before_due AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='0' AND r->>'visited_scopes'='0' FROM before_due)
 AND NOT EXISTS(SELECT 1 FROM union_accounting_runs),
 'a newly closed week has no attempt or invented visit row before Monday 4 AM Chicago');

SET test.clock='2026-09-14T09:20:00Z';
CREATE TEMP TABLE first_tick AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'success'='false' AND r->>'checked'='8' AND r->>'failed'='8'
 AND r->>'visited_scopes'='8' AND r->>'more_remaining'='true' AND jsonb_array_length(r->'detail')=8 FROM first_tick),
 'first scheduler call reports exactly eight failed attempts, not eight attempts per child');
SELECT assert_true((SELECT count(*)=8 AND bool_and(status='failed' AND attempts=1 AND last_scheduler_visit_at='2026-09-14 09:20Z') FROM union_accounting_runs)
 AND NOT EXISTS(SELECT 1 FROM union_accounting_runs WHERE union_id=u(1009) OR standalone_club_id=u(11))
 AND (SELECT count(*)=8 FROM financial_alerts),'first eight blocked unions have durable truthful attempts and one alert each');
SELECT assert_true((SELECT chip_treasury=200 FROM clubs WHERE id=u(11))
 AND NOT EXISTS(SELECT 1 FROM accounting_routed_settlement_runs) AND NOT EXISTS(SELECT 1 FROM settlement_invoices),
 'refused union work cannot consume the healthy standalone treasury or produce paid documents');

SET test.clock='2026-09-14T09:21:00Z';
CREATE TEMP TABLE second_tick AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='8' AND r->>'failed'='7' AND r->>'visited_scopes'='8'
 AND r->'detail'->0->>'union_id'=u(1009)::text AND r->'detail'->1->>'club_id'=u(11)::text
 AND r->'detail'->1->'result'->>'success'='true' FROM second_tick),
 'second call visits untouched ninth union and standalone club before retrying recent unions');
SELECT assert_true((SELECT count(*)=10 AND sum(attempts)=16 FROM union_accounting_runs)
 AND (SELECT status='complete' AND attempts=1 AND result->>'accounting_version'='3' FROM union_accounting_runs WHERE standalone_club_id=u(11))
 AND (SELECT count(*)=9 FROM financial_alerts),'common scope rotation retains attempt counts and suppresses unchanged repeated failure alerts');
SELECT assert_true((SELECT chip_treasury=153.40 FROM clubs WHERE id=u(11))
 AND (SELECT sum(chip_balance)=46.60 FROM club_members WHERE club_id=u(11))
 AND (SELECT count(*)=2 FROM accounting_routed_settlement_runs WHERE scope_kind='club' AND scope_id=u(11)),
 'healthy standalone reaches actual routed payout stages and conserves exact balances');
SELECT assert_true((SELECT count(*)=7 FROM settlement_invoices)
 AND (SELECT count(*)=11 FROM notifications) AND (SELECT count(*)=11 FROM social_messages)
 AND (SELECT count(*)=1 FROM settlement_invoices WHERE invoice_type='club_weekly_accounting'),
 'healthy standalone produces real transfer invoices and one club weekly summary with Messenger and notification receipts');

CREATE TEMP TABLE paid_snapshot AS SELECT test_scheduler_money_snapshot() AS value;
CREATE TEMP TABLE completed_run AS SELECT to_jsonb(q)-'last_scheduler_visit_at' AS value
 FROM union_accounting_runs q WHERE standalone_club_id=u(11);
UPDATE union_accounting_runs SET last_scheduler_visit_at='2026-09-14 09:30Z' WHERE union_id IS NOT NULL;
SET test.clock='2026-09-14T09:31:00Z';
CREATE TEMP TABLE zero_work_tick AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='8' AND r->>'failed'='8' AND r->>'visited_scopes'='9'
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'detail')d WHERE d ? 'club_id') FROM zero_work_tick),
 'a completed oldest book consumes no financial attempt and does not prevent eight later books from being attempted');
SELECT assert_true((SELECT to_jsonb(q)-'last_scheduler_visit_at'=(SELECT value FROM completed_run)
 AND last_scheduler_visit_at='2026-09-14 09:31Z' FROM union_accounting_runs q WHERE standalone_club_id=u(11)),
 'completed book visitation advances without modifying attempts, result, started or finished accounting facts');
SELECT assert_true(test_scheduler_money_snapshot()=(SELECT value FROM paid_snapshot),
 'revisiting completed books cannot change balances, payments, source receipts, invoices or messages');
SELECT assert_true((SELECT count(*)=9 FROM financial_alerts),'scheduler visits and unchanged refusals do not create duplicate financial alerts');

BEGIN;
INSERT INTO unions(id,name,owner_id) VALUES(u(1010),'Sunday Floor',u(902)),(u(1011),'Future Floor',u(902));
INSERT INTO union_settlement_floor VALUES(u(1010),'2026-09-06 12:00Z'),(u(1011),'2026-09-14 07:00Z');
SET LOCAL test.clock='2026-09-14T09:32:00Z';
CREATE TEMP TABLE sunday_tick AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->'detail'->0->>'union_id'=u(1010)::text
 AND (r->'detail'->0->>'period_start')::timestamptz='2026-09-07 07:00Z' FROM sunday_tick),
 'Sunday clean floor rounds from its containing week and includes the next whole due week');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM union_accounting_runs WHERE union_id=u(1011)),
 'future-floor union is excluded without creating a fake skipped or complete journal entry');
ROLLBACK;

BEGIN;
UPDATE union_settlement_floor SET earliest_period_start='2026-08-24 07:00Z' WHERE union_id=u(1001);
SET LOCAL test.clock='2026-09-14T08:30:00Z';
CREATE TEMP TABLE older_due_tick AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='1' AND r->>'failed'='1' AND r->>'visited_scopes'='1'
 AND r->'detail'->0->>'union_id'=u(1001)::text
 AND (r->'detail'->0->>'period_start')::timestamptz='2026-08-24 07:00Z' FROM older_due_tick),
 'older overdue union backlog remains eligible before this Monday new week becomes due');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM union_accounting_runs WHERE union_id=u(1001) AND period_start='2026-08-31 07:00Z'),
 'failed oldest union week blocks later weeks only in that same book');
ROLLBACK;

BEGIN;
-- A known failed week survives the next Monday even without an explicit floor.
DELETE FROM union_settlement_floor WHERE union_id=u(1001);
UPDATE union_settlement_floor SET earliest_period_start='2026-09-21 07:00Z';
UPDATE clubs SET is_union=true WHERE id=u(11);
SET LOCAL test.clock='2026-09-21T09:20:00Z';
CREATE TEMP TABLE rollover_tick AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='1' AND r->>'failed'='1' AND r->>'visited_scopes'='1'
 AND r->'detail'->0->>'union_id'=u(1001)::text
 AND (r->'detail'->0->>'period_start')::timestamptz='2026-09-07 07:00Z' FROM rollover_tick)
 AND NOT EXISTS(SELECT 1 FROM union_accounting_runs WHERE union_id=u(1001) AND period_start='2026-09-14 07:00Z'),
 'calendar rollover cannot skip a recorded unresolved union week when its clean floor is absent');
ROLLBACK;

BEGIN;
-- A clean floor explicitly limits how far back known history can recover.
CREATE TEMP TABLE historical_run AS SELECT to_jsonb(q) AS value FROM union_accounting_runs q WHERE union_id=u(1001);
UPDATE union_settlement_floor SET earliest_period_start='2026-09-14 07:00Z';
SET LOCAL test.clock='2026-09-14T09:32:00Z';
CREATE TEMP TABLE floor_tick AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='0' FROM floor_tick)
 AND (SELECT to_jsonb(q)=(SELECT value FROM historical_run) FROM union_accounting_runs q WHERE union_id=u(1001)),
 'an unresolved journal row below an explicit clean floor is preserved but cannot reopen an excluded financial week');
ROLLBACK;

BEGIN;
CREATE TEMP TABLE alert_count AS SELECT count(*) AS n FROM financial_alerts;
INSERT INTO rakeback_periods(id,user_id,club_id,period_start,period_end,rakeback_amount,status)
 VALUES(u(1901),u(301),u(1001),'2026-09-07','2026-09-13',1,'pending');
SELECT fn_process_weekly_accounting(u(1001));
SELECT fn_process_weekly_accounting(u(1001));
SELECT assert_true((SELECT count(*)=(SELECT n+1 FROM alert_count) FROM financial_alerts)
 AND (SELECT result->>'error'='union_rakeback_wrong_club' FROM union_accounting_runs WHERE union_id=u(1001)),
 'changed refusal still creates a new alert once without being hidden by fairness metadata');
ROLLBACK;

BEGIN;
CREATE TEMP TABLE before_pause AS SELECT jsonb_agg(to_jsonb(q) ORDER BY scope_kind,scope_id,period_start) AS value FROM union_accounting_runs q;
SET LOCAL app.weekly_accounting_scheduler_started='2026-09-14T09:00:00Z';
CREATE TEMP TABLE elapsed_tick AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='0' AND r->>'visited_scopes'='0' AND r->>'more_remaining'='true' FROM elapsed_tick)
 AND current_setting('app.weekly_accounting_scheduler_started')='2026-09-14T09:00:00Z',
 'one inherited total deadline prevents nested scope calls from receiving fresh fifteen-minute windows');
SELECT assert_true((SELECT jsonb_agg(to_jsonb(q) ORDER BY scope_kind,scope_id,period_start)=(SELECT value FROM before_pause) FROM union_accounting_runs q),
 'an exhausted deadline does not fabricate an attempt or visitation');
ROLLBACK;
BEGIN;
SET LOCAL test.clock='2026-09-14T09:50:00Z';
SELECT assert_true(fn_process_weekly_accounting(NULL)->>'reason'='maintenance_window','maintenance time still stops the shared coordinator');
ROLLBACK;
BEGIN;
SET LOCAL test.frozen='true';
SELECT assert_true(fn_process_weekly_accounting(NULL)->>'reason'='maintenance_window','platform freeze still stops the shared coordinator');
ROLLBACK;

BEGIN;
SET LOCAL test.is_engine='false';
SELECT assert_true(refuses($$SELECT fn_process_weekly_accounting(NULL)$$,'not_authorised'),
 'non-engine actor cannot initiate either all-scope or recursive accounting');
ROLLBACK;
SELECT assert_true(NOT has_function_privilege('anon','public.fn_process_weekly_accounting_scope(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.fn_process_weekly_accounting_scope(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('service_role','public.fn_process_weekly_accounting_scope(uuid,uuid)','EXECUTE')
 AND NOT has_table_privilege('service_role','union_accounting_runs','UPDATE'),
 'private implementation and durable financial journal keep their API access restrictions');
SELECT assert_true(NOT has_function_privilege('service_role','public.fn_close_settlement_period(uuid)','EXECUTE')
 AND (SELECT prosrc NOT LIKE '%UPDATE%' AND prosrc LIKE '%automatic_weekly_settlement%' FROM pg_proc WHERE oid='fn_claim_rakeback(uuid)'::regprocedure),
 'fairness preserves the legacy direct-payer retirement');
BEGIN;
SET LOCAL app.weekly_accounting_attempt_budget='1';
CREATE TEMP TABLE bounded_tick AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='1' FROM bounded_tick)
 AND current_setting('app.weekly_accounting_attempt_budget')='1'
 AND COALESCE(current_setting('app.weekly_accounting_scheduler_started',true),'')='',
 'smaller caller budget is honored and both inherited settings are restored after recursion');
ROLLBACK;
