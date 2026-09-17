CREATE FUNCTION run_standalone() RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE a jsonb;b jsonb;BEGIN
 a:=fn_settle_accounting_commission_stage('club',u(11),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z');
 b:=fn_settle_accounting_rakeback_stage('club',u(11),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z');
 RETURN jsonb_build_object('r2',a,'r3',b);END$$;
BEGIN;
DELETE FROM union_clubs;
UPDATE accounting_cash_rake_sources SET coordinator_union_id=NULL,union_id=NULL;
UPDATE accounting_rakeback_period_calculations SET coordinator_union_id=NULL;
SET LOCAL app.accounting_routing_context='standalone-caller';
CREATE TEMP TABLE standalone_result AS SELECT run_standalone() AS value;
SELECT assert_true((SELECT value->'r2'->>'amount' FROM standalone_result)::numeric=45.6
 AND (SELECT value->'r3'->>'amount' FROM standalone_result)::numeric=16
 AND (SELECT chip_treasury FROM clubs)=153.4 AND (SELECT sum(chip_balance) FROM club_members)=46.6,'standalone clubs use the exact same funded commission and player stages');
SELECT assert_true((SELECT count(*) FROM accounting_routed_settlement_runs WHERE union_id IS NULL AND standalone_club_id=u(11) AND scope_kind='club' AND scope_id=u(11))=2
 AND NOT EXISTS(SELECT 1 FROM chip_ledger WHERE union_id IS NOT NULL),'standalone receipts and journals never invent a union');
SELECT assert_true(current_setting('app.accounting_routing_context')='standalone-caller'
 AND (SELECT count(*) FROM test_deliveries WHERE routing_context='club:'||u(11)::text||':2026-09-07 07:00:00+00:2026-09-14 07:00:00+00')=6,'standalone delivery uses an exact club scope and restores calling context');
SELECT assert_true((SELECT bool_and(value->>'duplicate'='true') FROM jsonb_each(run_standalone()))
 AND (SELECT count(*) FROM chip_ledger)=6,'standalone exact replay cannot transfer or deliver twice');
ROLLBACK;
BEGIN;
-- Recorded standalone earnings remain with that scope after the club joins a union.
UPDATE accounting_cash_rake_sources SET coordinator_union_id=NULL,union_id=NULL;
UPDATE accounting_rakeback_period_calculations SET coordinator_union_id=NULL;
SELECT run_standalone();
SELECT assert_true((SELECT chip_treasury FROM clubs)=153.4,'later joining a union cannot reassign standalone historical obligations');
ROLLBACK;
BEGIN;
DELETE FROM union_clubs;
UPDATE accounting_cash_rake_sources SET coordinator_union_id=NULL,union_id=NULL;
UPDATE accounting_rakeback_period_calculations SET coordinator_union_id=NULL;
INSERT INTO clubs VALUES(u(12),300);
INSERT INTO accounting_cash_rake_sources SELECT u(404),u(504),player_id,u(12),NULL,NULL,earned_at,rake_credit,contract FROM accounting_cash_rake_sources WHERE id=u(401);
SELECT run_standalone();
SELECT assert_true((SELECT chip_treasury FROM clubs WHERE id=u(12))=300 AND NOT EXISTS(SELECT 1 FROM chip_ledger WHERE club_id=u(12)),'standalone NULL coordinator admits only the requested club, never other independent clubs');
ROLLBACK;
BEGIN;
SELECT assert_true(refuses('SELECT fn_settle_accounting_commission_stage(''all'',u(11),''2026-09-07T07:00Z'',''2026-09-14T07:00Z'')','invalid_accounting_routing_scope')
 AND refuses('SELECT fn_settle_accounting_rakeback_stage(''club'',NULL,''2026-09-07T07:00Z'',''2026-09-14T07:00Z'')','invalid_accounting_routing_scope')
 AND refuses('SELECT fn_settle_accounting_rakeback_stage(''club'',u(999),''2026-09-07T07:00Z'',''2026-09-14T07:00Z'')','invalid_accounting_routing_scope'),'invalid, global, missing or unknown accounting scopes are refused');
ROLLBACK;
BEGIN;
DELETE FROM union_clubs;
UPDATE accounting_cash_rake_sources SET coordinator_union_id=NULL,union_id=NULL;
UPDATE accounting_rakeback_period_calculations SET coordinator_union_id=NULL;
SET LOCAL test.delivery_failure='rakeback';
SELECT assert_true(refuses('SELECT run_standalone()','test invoice delivery failure')
 AND (SELECT chip_treasury FROM clubs)=200 AND NOT EXISTS(SELECT 1 FROM chip_ledger)
 AND NOT EXISTS(SELECT 1 FROM accounting_routed_settlement_runs),'standalone downstream failure rolls back the shared full waterfall');
ROLLBACK;
SELECT assert_true(NOT has_function_privilege('service_role','fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)','execute')
 AND NOT has_function_privilege('service_role','fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)','execute')
 AND NOT has_function_privilege('authenticated','fn_resolve_accounting_routing_scope(text,uuid,timestamptz,timestamptz)','execute'),'shared stages and resolver remain private behind the single coordinator');
BEGIN;
DELETE FROM union_clubs;
UPDATE accounting_cash_rake_sources SET coordinator_union_id=NULL,union_id=NULL;
UPDATE accounting_rakeback_period_calculations SET coordinator_union_id=NULL;
INSERT INTO unions VALUES(u(11));
SELECT fn_settle_accounting_commission_stage('union',u(11),'2026-09-07T07:00Z','2026-09-14T07:00Z');
SELECT fn_settle_accounting_rakeback_stage('union',u(11),'2026-09-07T07:00Z','2026-09-14T07:00Z');
SELECT assert_true((SELECT count(*) FROM accounting_routed_settlement_runs)=2 AND NOT EXISTS(SELECT 1 FROM chip_ledger),'an unrelated union sharing the club UUID cannot claim standalone sources');
SELECT run_standalone();
SELECT assert_true((SELECT count(*) FROM accounting_routed_settlement_runs WHERE scope_id=u(11))=4
 AND (SELECT count(*) FROM chip_ledger)=6,'explicit scope kind separates union and standalone completion identities even for identical UUIDs');
ROLLBACK;
