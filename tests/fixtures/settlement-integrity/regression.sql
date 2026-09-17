SET timezone='UTC';
INSERT INTO unions VALUES(u(1));
INSERT INTO union_settlement_floor VALUES(u(1),'2026-09-07T00:00:00Z');
INSERT INTO clubs(id,chip_treasury) VALUES(u(11),99.99),(u(12),20),(u(13),0);
INSERT INTO union_clubs VALUES(u(1),u(11)),(u(1),u(12)),(u(1),u(13));
INSERT INTO union_wallets VALUES(u(1),0);
INSERT INTO pnl_input VALUES(u(11),-100,5,true),(u(12),70,2,false),(u(13),30,1,true);
CREATE FUNCTION run_pnl() RETURNS jsonb LANGUAGE sql AS $$SELECT fn_union_settle_player_pnl(u(1),'2026-09-07T07:00Z','2026-09-14T07:00Z',false)$$;
CREATE TABLE pnl_result(value jsonb);
INSERT INTO pnl_result SELECT run_pnl();
SELECT assert_true((SELECT value->>'error' FROM pnl_result)='pnl_club_funding_shortfall','one-cent club shortfall refuses the entire settlement');
SELECT assert_true((SELECT chip_treasury FROM clubs WHERE id=u(11))=99.99 AND (SELECT chip_balance FROM union_wallets)=0
 AND NOT EXISTS(SELECT 1 FROM chip_transactions) AND NOT EXISTS(SELECT 1 FROM settlement_invoices)
 AND NOT EXISTS(SELECT 1 FROM settlement_periods),'insufficient club funding creates no transfer, invoice, or completed/processing period');
SELECT assert_true((SELECT status FROM union_pnl_settlements)='failed' AND (SELECT state FROM ca_settlements)='failed'
 AND (SELECT count(*) FROM pnl_incidents)=1,'failed claim and incident survive the rollback');
UPDATE clubs SET chip_treasury=100 WHERE id=u(11);
UPDATE union_wallets SET chip_balance=NULL;
SELECT assert_true(run_pnl()->>'error'='pnl_invalid_funding_balance' AND (SELECT chip_balance FROM union_wallets) IS NULL,'unknown union funding is preserved and never assumed zero');
DELETE FROM union_wallets;
SELECT assert_true(run_pnl()->>'error'='pnl_union_wallet_missing' AND NOT EXISTS(SELECT 1 FROM union_wallets),'missing funding account is refused instead of fabricated');
INSERT INTO union_wallets VALUES(u(1),0);
UPDATE clubs SET chip_treasury='NaN' WHERE id=u(11);
SELECT assert_true(run_pnl()->>'error'='pnl_invalid_funding_balance','nonfinite treasury cannot pass funding preflight');
UPDATE clubs SET chip_treasury=100 WHERE id=u(11);
UPDATE pnl_input SET net=70.01 WHERE club_id=u(12);
TRUNCATE pnl_result;INSERT INTO pnl_result SELECT run_pnl();
SELECT assert_true((SELECT value->>'error' FROM pnl_result)='pnl_union_funding_shortfall','one-cent union shortfall refuses without prorating winners');
SELECT assert_true((SELECT chip_treasury FROM clubs WHERE id=u(11))=100 AND NOT EXISTS(SELECT 1 FROM chip_transactions),'winner-funding preflight runs before collecting any club');
UPDATE pnl_input SET net=70 WHERE club_id=u(12);
SET test.pnl_missing_receipt='true';
SELECT assert_true(run_pnl()->>'error'='pnl_posted_receipt_missing_or_ambiguous'
 AND (SELECT chip_treasury FROM clubs WHERE id=u(11))=100,'a disabled or missing central receipt aborts the money movement');
SET test.pnl_missing_receipt='false';
SET test.pnl_delivery_failure='true';
TRUNCATE pnl_result;INSERT INTO pnl_result SELECT run_pnl();
SELECT assert_true((SELECT value->>'error' FROM pnl_result)='pnl invoice notification failure','real transfer writer reaches invoice delivery failure');
SELECT assert_true((SELECT chip_treasury FROM clubs WHERE id=u(11))=100 AND (SELECT chip_treasury FROM clubs WHERE id=u(12))=20
 AND NOT EXISTS(SELECT 1 FROM union_wallet_transactions) AND NOT EXISTS(SELECT 1 FROM chip_transactions)
 AND NOT EXISTS(SELECT 1 FROM settlement_invoices) AND NOT EXISTS(SELECT 1 FROM pnl_delivery)
 AND NOT EXISTS(SELECT 1 FROM settlement_periods),'delivery failure rolls collection, payout, journal, invoices and periods back together');
SET test.pnl_delivery_failure='false';
SET app.ledger_category='fixture_previous';SET app.ledger_counterparty='fixture_account';
SET app.ledger_counterparty_entity='fixture_entity';SET app.ledger_settlement='fixture_settlement';SET app.ledger_autoskip_union_wallets='fixture_skip';
BEGIN;
TRUNCATE pnl_result;INSERT INTO pnl_result SELECT run_pnl();
SELECT assert_true(current_setting('app.ledger_category')='fixture_previous' AND current_setting('app.ledger_counterparty')='fixture_account'
 AND current_setting('app.ledger_counterparty_entity')='fixture_entity' AND current_setting('app.ledger_settlement')='fixture_settlement'
 AND current_setting('app.ledger_autoskip_union_wallets')='fixture_skip','successful writer restores surrounding journal context within the transaction');
COMMIT;
SELECT assert_true((SELECT value->>'success' FROM pnl_result)='true' AND (SELECT (value->>'total_unpaid')::numeric FROM pnl_result)=0,'funded retry settles every obligation');
SELECT assert_true((SELECT chip_treasury FROM clubs WHERE id=u(11))=0 AND (SELECT chip_treasury FROM clubs WHERE id=u(12))=90
 AND (SELECT chip_treasury FROM clubs WHERE id=u(13))=30 AND (SELECT chip_balance FROM union_wallets)=0,'all players, including horses, receive exact complete transfers');
SELECT assert_true((SELECT count(*) FROM settlement_invoices)=3 AND (SELECT count(*) FROM pnl_delivery)=3
 AND NOT EXISTS(SELECT 1 FROM settlement_invoices WHERE net_amount<>gross_amount OR deductions<>0 OR status<>'paid' OR NOT chips_transferred OR source_ledger_id IS NULL),'every full transfer reuses one paid source-ledger invoice and delivery');
SELECT assert_true((SELECT count(*) FROM settlement_periods WHERE status='settled')=3 AND (SELECT state FROM ca_settlements)='final'
 AND (SELECT count(*) FROM union_pnl_settlements WHERE status='settled' AND total_unpaid=0)=1,'complete periods, state machine and claim agree');
SELECT assert_true(run_pnl()->>'already_settled'='true' AND (SELECT count(*) FROM settlement_invoices)=3,'exact fully paid replay never moves chips or duplicates receipts');
SELECT assert_true(fn_union_settle_player_pnl(u(1),'2026-09-07T07:00Z','2026-09-13T07:00Z',false)->>'error'='pnl_period_overlap','same start with a different end is not a successful replay');
SELECT assert_true(fn_union_settle_player_pnl(u(1),'2026-09-08T07:00Z','2026-09-14T07:00Z',false)->>'error'='pnl_period_overlap','overlapping windows cannot pay an already settled obligation again');
UPDATE union_pnl_settlements SET total_unpaid=0.01 WHERE status='settled';
SELECT assert_true(run_pnl()->>'error'='legacy_partial_pnl_requires_reconciliation' AND (SELECT count(*) FROM settlement_invoices)=3,'legacy partial settlement is preserved and refused, never treated as done or repaid');
UPDATE union_pnl_settlements SET total_unpaid=NULL WHERE status='settled';
SELECT assert_true(run_pnl()->>'error'='legacy_partial_pnl_requires_reconciliation','unknown historical unpaid balance is not certified zero');
UPDATE union_pnl_settlements SET total_unpaid=0,status='in_progress' WHERE status='settled';
SELECT assert_true(run_pnl()->>'error'='pnl_claim_requires_reconciliation','an in-progress claim is not reported already settled');
SELECT assert_true(fn_union_settle_player_pnl(u(1),'2026-09-01T07:00Z','2026-09-07T07:00Z',false)->>'error'='before_settlement_floor','historical clean floor is enforced by the core P&L writer');
SELECT assert_true(fn_union_settle_player_pnl(u(1),'2026-09-14T07:00Z','infinity',false)->>'error'='invalid_period','infinite period is refused');
SET test.is_engine='false';
SELECT assert_true(refuses('SELECT run_pnl()','42501') AND NOT has_function_privilege('anon','fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean)','execute')
 AND NOT has_function_privilege('authenticated','fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean)','execute'),'P&L requires trusted server authority and is not exposed to clients');
SET test.is_engine='true';

-- Run the actual coordinator and actual batch around one persistent per-player failure.
TRUNCATE unions,union_clubs,union_settlement_floor,rakeback_periods;
UPDATE clubs SET chip_treasury=100 WHERE id=u(11);
CREATE FUNCTION test_clock() RETURNS timestamptz LANGUAGE sql AS $$SELECT current_setting('test.clock')::timestamptz$$;
DO $$DECLARE d text;BEGIN SELECT pg_get_functiondef('fn_process_weekly_accounting(uuid)'::regprocedure) INTO d;EXECUTE replace(d,'clock_timestamp()','public.test_clock()');END$$;
SET test.clock='2026-09-14T09:20:00Z';
INSERT INTO rakeback_periods(club_id,period_start,period_end,status,rakeback_amount) VALUES(u(11),'2026-09-07','2026-09-13','pending',3.99);
CREATE OR REPLACE FUNCTION fn_close_settlement_period(uuid) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
 RETURN jsonb_build_object('success',false,'error',COALESCE(current_setting('test.standalone_failure',true),'no_membership_at_earning_club'));
END$$;
TRUNCATE pnl_result;INSERT INTO pnl_result SELECT fn_process_weekly_accounting(NULL);
SELECT assert_true((SELECT value->>'success' FROM pnl_result)='false' AND (SELECT count(*) FROM financial_alerts WHERE source='weekly_club_accounting')=1,'standalone failure records one alert from the real coordinator');
SELECT pg_sleep(0.025);
SELECT fn_process_weekly_accounting(NULL);
SELECT assert_true((SELECT count(*) FROM financial_alerts WHERE source='weekly_club_accounting')=1,'changed elapsed runtime does not duplicate an unchanged failure alert');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM financial_alerts WHERE source='weekly_club_accounting'
 AND (context->'result'->>'detail')::jsonb ?| ARRAY['elapsed_seconds','clock_ran_out']),'failure identity omits only runtime telemetry');
SET test.standalone_failure='invalid_contract_rate';
SELECT fn_process_weekly_accounting(NULL);
SELECT assert_true((SELECT count(*) FROM financial_alerts WHERE source='weekly_club_accounting')=2,'a substantively different failure still raises a new alert');
