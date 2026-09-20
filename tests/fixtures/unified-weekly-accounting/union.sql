SET timezone='UTC';SET test.clock='2026-09-14T09:20:00Z';
DELETE FROM accounting_cash_bank_receipts WHERE rake_record_id=u(501);
DELETE FROM chip_ledger WHERE id=u(501);
INSERT INTO ca_settlements VALUES(u(888),'union_rakeback_close',u(1),'final',u(1)::text||':2026-09-07T07:00:00Z..2026-09-14T07:00:00Z',
 jsonb_build_object('accounting_version',3,'period_rake',100,'payout_total',90,'retained',10,'basis_by_club',jsonb_build_object(u(11)::text,100),'payout_by_club',jsonb_build_object(u(11)::text,90)));
INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,created_at,settlement_id)
 VALUES(u(889),'union_wallet',u(1),'club_treasury',u(11),90,'rakeback',u(11),u(1),'2026-09-14 07:05Z',u(888)::text);
INSERT INTO union_wallets VALUES(u(777),u(1),1000,10);
SET test.weekly_failure='true';
SELECT fn_process_weekly_accounting(u(1));
SELECT assert_true((SELECT status='failed' AND result->>'error'='fixture weekly notification failure' FROM union_accounting_runs),'union records the real final statement delivery failure');
SELECT assert_true((SELECT chip_treasury=200 FROM clubs) AND NOT EXISTS(SELECT 1 FROM union_settlement_rounds) AND NOT EXISTS(SELECT 1 FROM accounting_routed_settlement_runs)
 AND NOT EXISTS(SELECT 1 FROM settlement_periods) AND (SELECT count(*)=1 FROM settlement_invoices),'failed union final statement rolls routed money and new documents back while preserving original paid R1 receipt');
SELECT assert_true((SELECT status='complete' FROM accounting_period_recompute_requests),'union preparation remains durable after financial subtransaction rollback');
SET test.weekly_failure='false';
SELECT fn_process_weekly_accounting(u(1));
SELECT assert_true((SELECT status='complete' AND union_id=u(1) AND standalone_club_id IS NULL AND attempts=2 FROM union_accounting_runs),'union retry completes in the same journal after the delivery issue is resolved');
SELECT assert_true((SELECT count(*)=4 FROM union_settlement_rounds) AND (SELECT count(*)=2 FROM accounting_routed_settlement_runs),'union completion records every stage and matches actual routed receipts');
SELECT assert_true((SELECT count(*)=2 FROM settlement_periods WHERE union_id=u(1) AND status='settled') AND (SELECT count(*)=1 FROM settlement_invoices WHERE invoice_type='club_weekly_accounting'),'union creates parent and member accounting periods and one consolidated member statement');
SELECT assert_true((SELECT chip_treasury=153.40 FROM clubs) AND (SELECT sum(chip_balance)=46.60 FROM club_members),'actual union routed balances equal standalone route for the same recorded entitlements');
SELECT assert_true(fn_process_weekly_accounting(u(1))->>'checked'='0' AND (SELECT attempts=2 FROM union_accounting_runs),'complete union retry reads its completion witness without duplicating money');

BEGIN;
ALTER TABLE accounting_routed_settlement_runs DISABLE TRIGGER USER;
DELETE FROM accounting_routed_settlement_runs WHERE round_no=2;
CREATE TEMP TABLE missing_union_route AS SELECT fn_process_weekly_accounting(u(1))r;
SELECT assert_true((SELECT r->>'checked'='1' AND r->>'failed'='1' FROM missing_union_route) AND (SELECT status='failed' FROM union_accounting_runs),'missing actual union routed receipt invalidates old round-header completion');
SELECT assert_true((SELECT chip_treasury=153.40 FROM clubs) AND (SELECT sum(chip_balance)=46.60 FROM club_members),'missing union stage evidence never causes a repayment');
ROLLBACK;
BEGIN;
UPDATE settlement_periods SET union_id=u(999) WHERE club_id=u(11);
SET LOCAL test.weekly_failure='true';
CREATE TEMP TABLE wrong_union_statement AS SELECT fn_process_weekly_accounting(u(1))r;
SELECT assert_true((SELECT r->>'checked'='1' AND r->>'failed'='1' FROM wrong_union_statement),'another union period statement cannot satisfy exact union completion');
ROLLBACK;
