BEGIN;
SELECT assert_true((SELECT count(*) FROM accounting_payable_earning_sources WHERE source_id=u(401))=2
 AND (SELECT count(DISTINCT source_type) FROM accounting_payable_earning_sources WHERE source_id=u(401))=2,'cash and tournament receipts retain distinct typed identities even when UUIDs coincide');
SELECT assert_true((SELECT earned_at FROM accounting_payable_earning_sources WHERE source_type='tournament_fee_accrual')='2026-09-10'::timestamptz
 AND (SELECT contract->>'terms_at' FROM accounting_payable_earning_sources WHERE source_type='tournament_fee_accrual')='2026-09-01','recognition time selects the tournament payment week while the original charge contract remains unchanged');
CREATE TEMP TABLE mixed_result AS SELECT run_all() AS value;
SELECT assert_true((SELECT value->'r2'->>'amount' FROM mixed_result)::numeric=59.68
 AND (SELECT value->'r2'->>'downstream_amount' FROM mixed_result)::numeric=83.2
 AND (SELECT value->'r3'->>'amount' FROM mixed_result)::numeric=20,'mixed cash and recognized fees route through the same exact commission and player payment bodies');
SELECT assert_true((SELECT chip_treasury FROM clubs)=139.32 AND (SELECT sum(chip_balance) FROM club_members)=60.68
 AND (SELECT chip_balance FROM club_members WHERE user_id=u(201))=19
 AND (SELECT chip_balance FROM club_members WHERE user_id=u(202))=7.2
 AND (SELECT chip_balance FROM club_members WHERE user_id=u(203))=14.48,'mixed sources conserve club outflow and each agent own net entitlement');
SELECT assert_true((SELECT count(*) FROM agent_commission_settlements)=3 AND (SELECT sum(amount) FROM agent_commission_settlements)=59.68
 AND (SELECT sum(rows_count) FROM agent_commission_settlements)=8
 AND (SELECT count(*) FROM chip_ledger)=6,'mixed sources create one routed weekly payment per edge and own-entitlement markers count both typed ledgers');
SELECT assert_true((SELECT count(*) FROM settlement_invoices)=6 AND (SELECT count(*) FROM accounting_invoice_deliveries)=10
 AND NOT EXISTS(SELECT 1 FROM accounting_invoice_deliveries WHERE recipient_id=u(901)),'mixed sources retain the same real source invoice and private delivery policy');
SELECT assert_true(run2()->>'duplicate'='true' AND run3()->>'duplicate'='true' AND (SELECT count(*) FROM chip_ledger)=6,'mixed-source retries cannot move or deliver a second payment');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM agent_commission_unsettled_rollup WHERE owed<>0 OR rows_behind<>0),'the real commission rollup reconciles both source types after payment');
ROLLBACK;
BEGIN;
DELETE FROM agents;
SELECT run_all();
SELECT assert_true((SELECT chip_balance FROM club_members WHERE user_id=u(203))=14.48
 AND (SELECT breakdown->>'payee_role_at_transfer' FROM settlement_invoices WHERE to_entity_id=u(203)::text)='super_agent'
 AND (SELECT breakdown->>'payee_role_at_transfer' FROM settlement_invoices WHERE to_entity_id=u(201)::text)='sub_agent'
 AND (SELECT count(*) FROM agent_commission_unsettled_rollup)=3,'retired agent profiles retain their recorded paid rights and invoice roles while the real rollup succeeds');
ROLLBACK;
BEGIN;
DELETE FROM agents;DELETE FROM club_members WHERE user_id=u(202);
SELECT assert_true(refuses('SELECT run_all()','routed_commission_wallet_identity_or_balance_invalid')
 AND (SELECT chip_treasury FROM clubs)=200 AND NOT EXISTS(SELECT 1 FROM chip_ledger),'retired profile support never invents a missing funded member wallet');
ROLLBACK;
BEGIN;
UPDATE accounting_tournament_fee_recognitions SET status='banked_accrual_deferred';
SELECT assert_true(NOT EXISTS(SELECT 1 FROM accounting_payable_earning_sources WHERE source_type='tournament_fee_accrual')
 AND refuses('SELECT run_all()','unclassified_commission_source_requires_reconciliation')
 AND NOT EXISTS(SELECT 1 FROM chip_ledger),'deferred bank recognition is excluded and cannot silently pay an existing tournament accrual');
ROLLBACK;
BEGIN;
UPDATE accounting_tournament_recognized_sources SET disposition='refunded',rake_credit=0;
SELECT assert_true(NOT EXISTS(SELECT 1 FROM accounting_payable_earning_sources WHERE source_type='tournament_fee_accrual')
 AND refuses('SELECT run_all()','unclassified_commission_source_requires_reconciliation'),'refunded fees cannot masquerade as commission income');
ROLLBACK;
BEGIN;
DELETE FROM accounting_tournament_recognized_sources;
SELECT assert_true(refuses('SELECT run_all()','unclassified_commission_source_requires_reconciliation'),'captured fee evidence alone is never payable without terminal recognition');
ROLLBACK;
BEGIN;
UPDATE accounting_tournament_recognized_sources SET rake_credit=rake_credit-.01;
SELECT assert_true(refuses('SELECT run_all()','unclassified_commission_source_requires_reconciliation'),'a recognition amount mismatch cannot fund a tournament liability');
ROLLBACK;
BEGIN;
UPDATE accounting_tournament_recognized_sources SET recognized_at='2026-09-09';
SELECT assert_true(refuses('SELECT run_all()','unclassified_commission_source_requires_reconciliation'),'the source recognition timestamp must match its terminal receipt');
ROLLBACK;
BEGIN;
UPDATE accounting_rakeback_period_calculations c SET source_allocations=(SELECT jsonb_agg(a-'source_type') FROM jsonb_array_elements(c.source_allocations)a);
SELECT assert_true(refuses('SELECT run_all()','routed_rakeback_sources_disagree_with_certificate')
 AND NOT EXISTS(SELECT 1 FROM chip_ledger),'new payouts require explicitly typed cash and tournament certificate allocations');
ROLLBACK;
BEGIN;
UPDATE accounting_rakeback_period_calculations c SET source_allocations=(SELECT jsonb_agg(CASE WHEN a->>'source_type'='tournament_fee_accrual' THEN a||jsonb_build_object('source_type','cash_rake_accrual') ELSE a END) FROM jsonb_array_elements(c.source_allocations)a);
SELECT assert_true(refuses('SELECT run_all()','routed_rakeback_sources_disagree_with_certificate'),'a colliding UUID cannot substitute a cash source for a tournament fee');
ROLLBACK;
BEGIN;
SET LOCAL test.delivery_failure='rakeback';
SELECT assert_true(refuses('SELECT run_all()','test real notification failure') AND (SELECT chip_treasury FROM clubs)=200
 AND NOT EXISTS(SELECT 1 FROM chip_ledger) AND NOT EXISTS(SELECT 1 FROM settlement_invoices)
 AND NOT EXISTS(SELECT 1 FROM social_messages) AND NOT EXISTS(SELECT 1 FROM notifications)
 AND NOT EXISTS(SELECT 1 FROM agent_commission_settlements) AND NOT EXISTS(SELECT 1 FROM accounting_routed_settlement_runs),'mixed-source downstream notification failure rolls back the entire shared waterfall');
ROLLBACK;
BEGIN;
DELETE FROM union_clubs;
UPDATE accounting_cash_rake_sources SET coordinator_union_id=NULL,union_id=NULL;
UPDATE accounting_tournament_fee_sources SET coordinator_union_id=NULL,union_id=NULL;
UPDATE accounting_tournament_fee_recognitions SET union_id=NULL;
UPDATE accounting_rakeback_period_calculations SET coordinator_union_id=NULL;
SELECT fn_settle_accounting_commission_stage('club',u(11),'2026-09-07T07:00Z','2026-09-14T07:00Z');
SELECT fn_settle_accounting_rakeback_stage('club',u(11),'2026-09-07T07:00Z','2026-09-14T07:00Z');
SELECT assert_true((SELECT chip_treasury FROM clubs)=139.32 AND (SELECT count(*) FROM accounting_routed_settlement_runs WHERE standalone_club_id=u(11))=2
 AND NOT EXISTS(SELECT 1 FROM chip_ledger WHERE union_id IS NOT NULL),'standalone clubs use the same mixed-source route without fabricating a union');
ROLLBACK;
SELECT assert_true(has_table_privilege('service_role','accounting_payable_earning_sources','SELECT')
 AND NOT has_table_privilege('service_role','accounting_payable_earning_sources','INSERT')
 AND NOT has_table_privilege('authenticated','accounting_payable_earning_sources','SELECT'),'the unified source reader is private and cannot become another source writer');
BEGIN;
DELETE FROM agent_commissions WHERE source_type='tournament_fee_accrual';
DELETE FROM accounting_tournament_recognized_sources;DELETE FROM accounting_tournament_fee_recognitions;DELETE FROM accounting_tournament_fee_sources;
UPDATE rakeback_periods SET rake_generated=100,total_rake_paid=100,rakeback_amount=10,rakeback_earned=10 WHERE id=u(601);
UPDATE accounting_rakeback_period_calculations SET rake_generated=100,rakeback_amount=10 WHERE period_id=u(601);
UPDATE accounting_rakeback_period_calculations c SET source_allocations=(SELECT jsonb_agg(a-'source_type') FROM jsonb_array_elements(c.source_allocations)a WHERE a->>'source_type'='cash_rake_accrual');
SELECT assert_true(refuses('SELECT run_all()','routed_rakeback_sources_disagree_with_certificate')
 AND (SELECT chip_treasury FROM clubs)=200 AND NOT EXISTS(SELECT 1 FROM chip_ledger),'an unpaid cash-only certificate cannot use the paid-run compatibility exception to omit source type');
ROLLBACK;
