\set ON_ERROR_STOP on
-- UNRUN. Fresh clone of load.sql, independent of regression.sql.
-- Seven failed unions precede a real empty standalone book with three due
-- weeks. The child must receive ONE remaining attempt, not eight of its own.
SET timezone='UTC';SET test.clock='2026-09-14T09:20:00Z';
UPDATE union_settlement_floor SET earliest_period_start='2026-09-14 07:00Z' WHERE union_id IN(u(1008),u(1009));
UPDATE clubs SET is_union=true WHERE id=u(11);
UPDATE accounting_cash_accrual_cutover SET starts_at='2026-08-24 07:00Z';
INSERT INTO clubs(id,chip_treasury,name,owner_id,is_union) VALUES(u(12),100,'Empty Backlog Club',u(901),false);
-- A preexisting failed bookkeeping attempt is real work-discovery evidence.
INSERT INTO union_accounting_runs(standalone_club_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES(u(12),'2026-08-24 07:00Z','2026-08-31 07:00Z','2026-08-31 09:00Z','failed',1,'{"success":false,"error":"fixture_interrupted_bookkeeping"}');
CREATE TEMP TABLE budget_first AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='8' AND r->>'failed'='7' AND r->>'more_remaining'='true'
 AND r->'detail'->7->>'club_id'=u(12)::text AND r->'detail'->7->'result'->>'success'='true'
 AND (r->'detail'->7->>'period_start')::timestamptz='2026-08-24 07:00Z' FROM budget_first),
 'seven failed union attempts leave exactly one real successful historical week for the child book');
SELECT assert_true((SELECT count(*)=1 AND bool_and(status='complete') FROM union_accounting_runs WHERE standalone_club_id=u(12))
 AND NOT EXISTS(SELECT 1 FROM union_accounting_runs WHERE standalone_club_id=u(12) AND period_start>='2026-08-31 07:00Z'),
 'shared cap prevents a child with successful multiweek backlog from expanding total work beyond eight');
-- No pending sources remain once the oldest empty week succeeds. Its complete
-- journal must still identify later due weeks until that backlog is caught up.
SET test.clock='2026-09-14T09:21:00Z';
CREATE TEMP TABLE budget_second AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='8' AND r->'detail'->7->>'club_id'=u(12)::text
 AND r->'detail'->7->'result'->>'success'='true'
 AND (r->'detail'->7->>'period_start')::timestamptz='2026-08-31 07:00Z' FROM budget_second),
 'next invocation continues an empty historical book at its next chronological week');
SET test.clock='2026-09-14T09:22:00Z';
CREATE TEMP TABLE budget_third AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='8' AND r->'detail'->7->>'club_id'=u(12)::text
 AND r->'detail'->7->'result'->>'success'='true'
 AND (r->'detail'->7->>'period_start')::timestamptz='2026-09-07 07:00Z' FROM budget_third)
 AND (SELECT count(*)=3 AND bool_and(status='complete') FROM union_accounting_runs WHERE standalone_club_id=u(12)),
 'empty book catches up all due weeks in order across bounded invocations');
SELECT assert_true((SELECT chip_treasury=100 FROM clubs WHERE id=u(12))
 AND NOT EXISTS(SELECT 1 FROM chip_ledger WHERE club_id=u(12))
 AND (SELECT count(*)=3 FROM settlement_invoices WHERE club_id=u(12) AND invoice_type='club_weekly_accounting' AND gross_amount=0 AND net_amount=0 AND message_sent),
 'zero-financial-work weeks produce accurate zero weekly statements without wallet transactions');
