BEGIN;
SET LOCAL app.accounting_routing_context='fixture-parent-context';
CREATE TEMP TABLE results AS SELECT run_all() AS value;
SELECT assert_true(current_setting('app.accounting_routing_context')='fixture-parent-context'
 AND (SELECT count(DISTINCT routing_context) FROM test_deliveries)=1,'both stages declare exact routing scope during receipt delivery and restore the calling context');
SELECT assert_true((SELECT value->'r2'->>'amount' FROM results)::numeric=45.60 AND (SELECT value->'r2'->>'downstream_amount' FROM results)::numeric=64,'R2 separates club outflow from downstream pass-through');
SELECT assert_true((SELECT chip_treasury FROM clubs)=153.40 AND (SELECT sum(chip_balance) FROM club_members)=46.60,'the full routed waterfall conserves every chip');
SELECT assert_true((SELECT chip_balance FROM club_members WHERE user_id=u(203))=11.60 AND (SELECT chip_balance FROM club_members WHERE user_id=u(202))=4
 AND (SELECT chip_balance FROM club_members WHERE user_id=u(201))=15,'agents retain their own commission less their recorded player rakeback');
SELECT assert_true((SELECT count(*) FROM chip_ledger WHERE category='commission' AND from_type='club_treasury')=1
 AND (SELECT to_entity_id FROM chip_ledger WHERE category='commission' AND from_type='club_treasury')=u(203),'the club pays only the recorded top agent');
SELECT assert_true((SELECT sum(amount) FROM agent_commission_settlements)=45.60
 AND (SELECT amount FROM agent_commission_settlements WHERE user_id=u(203))=11.60,'own commission settlement markers do not mistake gross pass-through for earnings');
SELECT assert_true((SELECT chip_balance FROM club_members WHERE user_id=u(301))=10 AND (SELECT chip_balance FROM club_members WHERE user_id=u(302))=5
 AND (SELECT chip_balance FROM club_members WHERE user_id=u(303))=1,'recorded agent payer and direct club payer work despite different current memberships');
SELECT assert_true((SELECT count(*) FROM chip_ledger)=6 AND (SELECT count(*) FROM settlement_invoices)=6 AND (SELECT count(*) FROM test_deliveries)=6,'every routed transfer has one source invoice and synchronous delivery');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM chip_ledger WHERE pre_from_balance-post_from_balance IS DISTINCT FROM amount
 OR post_to_balance-pre_to_balance IS DISTINCT FROM amount),'each journal leg records both exact before and after account balances');
SELECT assert_true(run2()->>'duplicate'='true' AND run3()->>'duplicate'='true' AND (SELECT count(*) FROM chip_ledger)=6,'both routed stages replay without moving or redelivering money');
ROLLBACK;
BEGIN;
UPDATE clubs SET chip_treasury=45.59;
SELECT assert_true(refuses('SELECT run2()','routed_commission_club_funding_shortfall') AND NOT EXISTS(SELECT 1 FROM chip_ledger),'one-cent club shortage prevents the complete agent round');
ROLLBACK;
BEGIN;
SELECT assert_true(refuses('SELECT run3()','routed_rakeback_agent_funding_shortfall') AND NOT EXISTS(SELECT 1 FROM rakeback_period_payouts),'all player payers must be funded before any player is paid');
ROLLBACK;
BEGIN;
SET LOCAL test.delivery_failure='rakeback';
SELECT assert_true(refuses('SELECT run_all()','test invoice delivery failure'),'the combined waterfall reaches downstream invoice failure');
SELECT assert_true((SELECT chip_treasury FROM clubs)=200 AND (SELECT sum(chip_balance) FROM club_members)=0
 AND NOT EXISTS(SELECT 1 FROM chip_ledger) AND NOT EXISTS(SELECT 1 FROM settlement_invoices)
 AND NOT EXISTS(SELECT 1 FROM agent_commission_settlements) AND NOT EXISTS(SELECT 1 FROM rakeback_period_payouts)
 AND NOT EXISTS(SELECT 1 FROM accounting_routed_settlement_runs),'downstream failure rolls every earlier route, receipt, marker and completion back');
ROLLBACK;
BEGIN;
SET LOCAL test.skip_receipt='true';
SELECT assert_true(refuses('SELECT run2()','routed_commission_invoice_delivery_incomplete') AND NOT EXISTS(SELECT 1 FROM chip_ledger),'a missing central receipt cannot leave unrecorded agent money');
ROLLBACK;
BEGIN;
UPDATE agent_commissions SET source_type='rake_settlement' WHERE source_id=u(401);
SELECT assert_true(refuses('SELECT run2()','unclassified_commission_source_requires_reconciliation'),'legacy commission source is refused without reinterpretation');
ROLLBACK;
BEGIN;
UPDATE agent_commissions SET amount=amount+.01 WHERE source_id=u(401) AND user_id=u(201);
SELECT assert_true(refuses('SELECT run2()','routed_commission_entitlement_disagrees_with_source'),'commission amount must agree with the immutable source contract');
ROLLBACK;
BEGIN;
INSERT INTO union_settlement_rounds VALUES(u(1),'2026-09-07T07:00Z','2026-09-14T07:00Z',2,1,1,1);
SELECT assert_true(refuses('SELECT run2()','legacy_commission_payment_requires_reconciliation'),'previous paid or partial legacy round is never paid again');
ROLLBACK;
BEGIN;
DELETE FROM club_members WHERE user_id=u(202);
SELECT assert_true(refuses('SELECT run2()','routed_commission_wallet_identity_or_balance_invalid'),'missing pass-through parent account aborts all payments');
ROLLBACK;
BEGIN;
DELETE FROM agent_commissions WHERE source_id=u(402);DELETE FROM accounting_cash_rake_sources WHERE id=u(402);
SELECT run2();
SELECT assert_true((SELECT chip_balance FROM club_members WHERE user_id=u(202))=0 AND (SELECT amount FROM agent_commission_settlements WHERE user_id=u(202))=0
 AND (SELECT amount FROM chip_ledger WHERE from_entity_id=u(203) AND to_entity_id=u(202))=20,'a zero-own-commission parent still receives and passes the exact child budget');
ROLLBACK;
BEGIN;
UPDATE agents SET parent_agent_id=NULL,commission_rate=.99,role='agent',status='inactive';DELETE FROM union_clubs;
SELECT run_all();
SELECT assert_true((SELECT count(*) FROM accounting_routed_settlement_runs)=2 AND (SELECT chip_balance FROM club_members WHERE user_id=u(203))=11.60,'recorded earning hierarchy and coordinator survive later parent, rate, role, status or union membership changes');
ROLLBACK;
BEGIN;
DELETE FROM accounting_rakeback_period_calculations WHERE period_id=u(601);
SELECT assert_true(refuses('SELECT run_all()','routed_rakeback_certificate_required') AND NOT EXISTS(SELECT 1 FROM chip_ledger),'an uncertified player period rolls the combined close back');
ROLLBACK;
BEGIN;
UPDATE rakeback_periods SET rakeback_amount=rakeback_amount+.01 WHERE id=u(601);
SELECT assert_true(refuses('SELECT run_all()','routed_rakeback_certificate_required'),'current player figures must equal the latest immutable calculation');
ROLLBACK;
BEGIN;
UPDATE accounting_cash_rake_sources SET coordinator_union_id=u(2) WHERE id=u(401);
SELECT assert_true(refuses('SELECT run3()','routed_rakeback_sources_disagree_with_certificate'),'a mixed recorded coordinator cannot be paid by the wrong union');
ROLLBACK;
BEGIN;
UPDATE rakeback_periods SET status='paid' WHERE id=u(601);
SELECT assert_true(refuses('SELECT run_all()','legacy_rakeback_payment_requires_reconciliation'),'legacy player payment cannot be replayed as a routed payment');
ROLLBACK;
BEGIN;
UPDATE accounting_cash_rake_sources SET contract=jsonb_set(contract,'{tiers}',jsonb_build_array(tier(102,202,101,'agent',10,.2),tier(101,201,103,'sub_agent',4,.1),tier(103,203,NULL,'super_agent',3.6,.1))) WHERE id=u(402);
DELETE FROM agent_commissions WHERE source_id=u(402);
INSERT INTO agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,created_at)
 SELECT s.club_id,(t->>'user_id')::uuid,(t->>'amount')::numeric,(t->>'rate')::numeric,'cash_rake_accrual',s.id,s.earned_at
 FROM accounting_cash_rake_sources s CROSS JOIN LATERAL jsonb_array_elements(s.contract->'tiers')t WHERE s.id=u(402);
SELECT assert_true(refuses('SELECT run2()','routed_commission_weekly_hierarchy_cycle') AND NOT EXISTS(SELECT 1 FROM chip_ledger),'individually valid historical chains cannot create a cyclic weekly payment graph');
ROLLBACK;
BEGIN;
UPDATE club_members SET chip_balance=NULL WHERE user_id=u(202);
SELECT assert_true(refuses('SELECT run2()','routed_commission_wallet_identity_or_balance_invalid'),'unknown agent balance is never assumed zero');
ROLLBACK;
BEGIN;
DELETE FROM accounting_cash_accrual_cutover;
SELECT assert_true(refuses('SELECT run2()','routed_commission_historical_period_uncertified') AND refuses('SELECT run3()','routed_rakeback_historical_period_uncertified'),'missing accounting cutover cannot enable historical payments');
ROLLBACK;
BEGIN;
SELECT run_all();
INSERT INTO accounting_cash_rake_sources SELECT u(404),u(504),u(304),club_id,union_id,coordinator_union_id,earned_at,0,jsonb_build_object('club_id',club_id,'tiers','[]'::jsonb) FROM accounting_cash_rake_sources WHERE id=u(401);
SELECT assert_true(refuses('SELECT run2()','routed_commission_source_changed_after_payment'),'a late source cannot be swallowed by a completed routing receipt');
ROLLBACK;
BEGIN;
DELETE FROM agent_commissions;UPDATE accounting_cash_rake_sources SET contract=jsonb_set(contract,'{tiers}','[]'::jsonb);
SELECT run2();
SELECT assert_true((SELECT count(*) FROM accounting_routed_settlement_runs WHERE round_no=2)=1 AND NOT EXISTS(SELECT 1 FROM chip_ledger)
 AND NOT EXISTS(SELECT 1 FROM agent_commission_settlements),'zero commission source scope still has an authoritative completed run without fabricated transfers');
ROLLBACK;
BEGIN;
INSERT INTO union_clubs VALUES(u(1),u(12));INSERT INTO clubs VALUES(u(12),100);
INSERT INTO agents VALUES(u(111),u(12),u(201),'sub_agent',u(112),.2,'active'),(u(112),u(12),u(202),'agent',u(113),0,'active'),(u(113),u(12),u(203),'super_agent',NULL,.1,'active');
INSERT INTO club_members(club_id,user_id,chip_balance) VALUES(u(12),u(201),0),(u(12),u(202),0),(u(12),u(203),0),(u(12),u(301),0);
INSERT INTO accounting_cash_rake_sources VALUES(u(404),u(504),u(301),u(12),u(1),u(1),'2026-09-08',100,
 jsonb_build_object('club_id',u(12),'membership',jsonb_build_object('terms',jsonb_build_object('agent_id',u(201))),
 'tiers',jsonb_build_array(tier(111,201,112,'sub_agent',20,.2),tier(112,202,113,'agent',0,0),tier(113,203,NULL,'super_agent',8,.1))));
INSERT INTO agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,created_at)
 SELECT s.club_id,(t->>'user_id')::uuid,(t->>'amount')::numeric,(t->>'rate')::numeric,'cash_rake_accrual',s.id,s.earned_at
 FROM accounting_cash_rake_sources s CROSS JOIN LATERAL jsonb_array_elements(s.contract->'tiers')t WHERE s.id=u(404) AND (t->>'amount')::numeric>0;
INSERT INTO rakeback_periods VALUES(u(604),u(301),u(12),'2026-09-07','2026-09-13',100,.1,10,'pending',NULL,10,100);
INSERT INTO accounting_rakeback_period_calculations(period_id,source_fingerprint,club_id,player_id,coordinator_union_id,period_start,period_end,rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations)
 VALUES(u(604),'fixture:604',u(12),u(301),u(1),'2026-09-07','2026-09-13',100,10,.1,'agent',u(201),
 jsonb_build_array(jsonb_build_object('source_type','cash_rake_accrual','source_id',u(404),'rake_record_id',u(504),'rake_credit',100,'rate',.1,'payer_kind','agent','payer_user_id',u(201))));
SELECT run_all();
SELECT assert_true((SELECT chip_balance FROM club_members WHERE club_id=u(11) AND user_id=u(201))=15
 AND (SELECT chip_balance FROM club_members WHERE club_id=u(12) AND user_id=u(201))=10
 AND (SELECT chip_treasury FROM clubs WHERE id=u(12))=72,'one agent and player in two clubs retain separate funded balances and obligations');
SELECT assert_true((SELECT count(*) FROM chip_ledger)=10 AND (SELECT count(*) FROM agent_commission_settlements)=6,'route keys and own-commission markers remain unique per club');
ROLLBACK;
BEGIN;
UPDATE accounting_cash_rake_sources SET contract=jsonb_set(contract,'{tiers}',CASE WHEN id=u(401)
 THEN jsonb_build_array(tier(101,201,102,'sub_agent',20,.2),tier(102,202,NULL,'agent',8,.1))
 ELSE jsonb_build_array(tier(101,201,102,'sub_agent',10,.2),tier(102,202,NULL,'agent',4,.1)) END) WHERE id IN(u(401),u(402));
DELETE FROM agent_commissions;
INSERT INTO agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,created_at)
 SELECT s.club_id,(t->>'user_id')::uuid,(t->>'amount')::numeric,(t->>'rate')::numeric,'cash_rake_accrual',s.id,s.earned_at
 FROM accounting_cash_rake_sources s CROSS JOIN LATERAL jsonb_array_elements(s.contract->'tiers')t;
SELECT run_all();
SELECT assert_true((SELECT to_entity_id FROM chip_ledger WHERE category='commission' AND from_type='club_treasury')=u(202)
 AND (SELECT chip_balance FROM club_members WHERE user_id=u(202))=12
 AND (SELECT chip_balance FROM club_members WHERE user_id=u(203))=0,'an ordinary agent with no recorded parent is the top funded recipient without inventing a super-agent');
ROLLBACK;
SELECT assert_true(NOT has_function_privilege('service_role','fn_settle_round2_club_to_agents(uuid,timestamptz,timestamptz)','execute')
 AND NOT has_function_privilege('service_role','fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)','execute')
 AND NOT has_function_privilege('authenticated','fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)','execute'),'low-level payment stages are private to the single coordinator');
SELECT assert_true(has_table_privilege('service_role','accounting_routed_settlement_runs','SELECT')
 AND NOT has_table_privilege('service_role','accounting_routed_settlement_runs','INSERT')
 AND NOT has_table_privilege('service_role','accounting_routed_settlement_runs','UPDATE')
 AND NOT has_table_privilege('service_role','accounting_routed_settlement_runs','DELETE')
 AND NOT has_table_privilege('service_role','accounting_routed_settlement_runs','TRUNCATE'),'default service grants cannot forge or rewrite a completed routed run');
