\set ON_ERROR_STOP on
-- UNRUN. Fresh load.sql database, independent of other regression files.
\ir legacy-recompute-preimage.sql
\ir ../../../supabase/accounting/weekly-v3/components/20260914155500_legacy_recompute_uses_the_single_weekly_coordinator.sql
SELECT assert_true(NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='union-weekly-rakeback-recompute')
 AND (SELECT count(*)=1 FROM cron.job WHERE active AND jobname='union-weekly-rakeback-close'),
 'only the duplicate recompute cron retires; the single automatic close scheduler remains');
CREATE TEMP TABLE initial_money AS SELECT test_scheduler_money_snapshot() AS value;
CREATE TEMP TABLE directed AS SELECT fn_rakeback_recompute_all_clubs('2026-09-07','2026-09-13') AS r;
SELECT assert_true((SELECT r->>'success'='false' AND r->>'reason'='legacy_date_recompute_retired'
 AND r->>'rows_written'='0' AND r->>'period_start'='2026-09-07' FROM directed)
 AND NOT EXISTS(SELECT 1 FROM union_accounting_runs)
 AND test_scheduler_money_snapshot()=(SELECT value FROM initial_money),
 'explicit old date request cannot silently widen into an all-scope financial run');
SET test.clock='2026-09-14T08:30:00Z';
CREATE TEMP TABLE not_due AS SELECT fn_rakeback_recompute_all_clubs() AS r;
SELECT assert_true((SELECT r->>'success'='true' AND r->>'checked'='0' AND r->>'visited_scopes'='0'
 AND r->>'delegated'='true' AND r->'rows_written'='null'::jsonb FROM not_due)
 AND NOT EXISTS(SELECT 1 FROM union_accounting_runs),
 'trusted compatibility call preserves coordinator due gate and leaves legacy counts unknown');
SET test.clock='2026-09-14T09:20:00Z';
CREATE TEMP TABLE blocked AS SELECT fn_rakeback_recompute_all_clubs() AS r;
SELECT assert_true((SELECT r->>'success'='false' AND r->>'failed'='8' AND r->>'checked'='8'
 AND r->>'authority'='fn_process_weekly_accounting' AND r->'clubs_failed'='null'::jsonb FROM blocked)
 AND (SELECT count(*)=8 FROM union_accounting_runs),
 'returned blocked work remains a failed coordinator receipt rather than a truthy legacy row count');
SET test.clock='2026-09-14T09:21:00Z';
CREATE TEMP TABLE next_call AS SELECT fn_rakeback_recompute_all_clubs() AS r;
SELECT assert_true((SELECT r->>'checked'='8' AND r->>'failed'='7'
 AND r->'detail'->1->>'club_id'=u(11)::text AND r->'detail'->1->'result'->>'success'='true' FROM next_call)
 AND (SELECT status='complete' AND attempts=1 FROM union_accounting_runs WHERE standalone_club_id=u(11)),
 'compatibility caller uses common fair discovery and can reach a standalone book outside current union membership');
SELECT assert_true((SELECT count(*)=7 FROM settlement_invoices) AND (SELECT count(*)=11 FROM notifications)
 AND (SELECT chip_treasury=153.40 FROM clubs WHERE id=u(11)),
 'compatibility delegation reaches actual atomic payouts and invoice delivery without another implementation');
BEGIN;
SET LOCAL test.is_engine='false';
SELECT assert_true(refuses($$SELECT fn_rakeback_recompute_all_clubs()$$,'not_authorised'),
 'non-engine actor cannot invoke the compatibility delegation');
ROLLBACK;
SELECT assert_true(has_function_privilege('service_role','fn_rakeback_recompute_all_clubs(date,date)','EXECUTE')
 AND NOT has_function_privilege('authenticated','fn_rakeback_recompute_all_clubs(date,date)','EXECUTE')
 AND NOT has_function_privilege('anon','fn_rakeback_recompute_all_clubs(date,date)','EXECUTE'),
 'legacy recompute remains service-only after retirement');
