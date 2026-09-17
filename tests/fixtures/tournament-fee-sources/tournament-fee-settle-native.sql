BEGIN;
SELECT fixture_fee(4000,true,1);
INSERT INTO fixture_tournament_fee_escrow VALUES(u(4000),1);
SELECT fn_settle_tournament_rake(u(4000),'fixture');
SELECT assert_true((SELECT balance=0 FROM fixture_tournament_fee_escrow WHERE tournament_id=u(4000)) AND (SELECT balance=1 FROM fixture_banks WHERE bank_kind='union'),'new proven fees move from exact escrow to actual union bank');
SELECT assert_true((fn_settle_tournament_rake(u(4000),'retry')->>'already_settled')::boolean AND (SELECT balance=1 FROM fixture_banks WHERE bank_kind='union'),'settlement retry never repeats bank transfer');
SELECT assert_true((SELECT count(*)=3 FROM agent_commissions WHERE source_id IN(SELECT id FROM accounting_tournament_fee_sources WHERE tournament_id=u(4000))) AND (SELECT count(*)=3 FROM vip_probe WHERE source_id=u(4000)),'terminal settlement preserves all commission contributors and VIP credit');
SELECT fixture_fee(4100,true,1);
INSERT INTO fixture_tournament_fee_escrow VALUES(u(4100),1);
SELECT set_config('fixture.stats_fail',u(4113)::text,true);
SELECT assert_sql_refuses('SELECT fn_settle_tournament_rake(u(4100),''fixture'')','injected_stats_failure','downstream failure rolls back fee bank transfer');
SELECT assert_true((SELECT balance=1 FROM fixture_tournament_fee_escrow WHERE tournament_id=u(4100)) AND (SELECT balance=1 FROM fixture_banks WHERE bank_kind='union') AND NOT EXISTS(SELECT 1 FROM tournament_rake_settlements WHERE tournament_id=u(4100)),'failed terminal transaction keeps fee in custody and no settlement claim');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM accounting_tournament_fee_recognitions WHERE tournament_id=u(4100)) AND NOT EXISTS(SELECT 1 FROM agent_commissions WHERE source_id IN(SELECT id FROM accounting_tournament_fee_sources WHERE tournament_id=u(4100))),'failed terminal transaction leaves no commission or recognition');
SELECT set_config('fixture.stats_fail','',true);
SELECT fn_settle_tournament_rake(u(4100),'retry');
SELECT assert_true((SELECT balance=2 FROM fixture_banks WHERE bank_kind='union'),'same failed terminal request safely succeeds once on retry');

SELECT fixture_fee(4200,true,1);
UPDATE tournament_players SET registered_at=transaction_timestamp()-interval '2 hours' WHERE tournament_id=u(4200);
UPDATE tournament_refund_entitlements SET created_at=transaction_timestamp()-interval '2 hours' WHERE tournament_id=u(4200);
UPDATE chip_ledger SET created_at=transaction_timestamp()-interval '2 hours' WHERE to_entity_id=u(4200);
INSERT INTO fixture_tournament_fee_escrow VALUES(u(4200),1);
SELECT assert_true((fn_settle_tournament_rake(u(4200),'legacy')->'accounting'->>'status')='banked_accrual_deferred','legacy charge fees bank with explicit deferred accounting');
SELECT assert_true((SELECT balance=0 FROM fixture_tournament_fee_escrow WHERE tournament_id=u(4200)) AND (SELECT attributed_at IS NULL AND attributed_users=0 AND attribution_error='tournament_fee_sources_require_reconciliation' FROM tournament_rake_settlements WHERE tournament_id=u(4200)),'deferred accounting leaves no fee custody and never fakes attribution');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM accounting_tournament_recognized_sources WHERE tournament_id=u(4200)) AND NOT EXISTS(SELECT 1 FROM vip_probe WHERE source_id=u(4200)),'deferred source posts neither guessed earnings nor VIP amounts');
SELECT assert_true((fn_accounting_tournament_terminal_fee_receipt(u(4200))->>'payable')='false','terminal deferred receipt remains explicitly not payable');
SELECT assert_true((fn_settle_tournament_rake(u(4200),'retry')->>'already_settled')::boolean AND (SELECT balance=3 FROM fixture_banks WHERE bank_kind='union'),'deferred terminal retry keeps the same bank transfer');

SELECT fixture_fee(4300);
UPDATE tournaments SET is_private=true WHERE id=u(4300);
INSERT INTO fixture_tournament_fee_escrow VALUES(u(4300),1);
SELECT fn_settle_tournament_rake(u(4300),'private');
SELECT assert_true((SELECT union_id IS NULL AND destination='chip_retirement:'||u(99)::text FROM tournament_rake_settlements WHERE tournament_id=u(4300)) AND (SELECT balance=0 FROM fixture_banks WHERE bank_kind='club') AND (SELECT balance=0 FROM fixture_tournament_fee_escrow WHERE tournament_id=u(4300)) AND EXISTS(SELECT 1 FROM chip_ledger WHERE from_type='prize_liability' AND from_entity_id=u(4300) AND to_type='chip_retirement' AND to_entity_id IS NULL AND club_id=u(99) AND amount=1 AND category='burn'),'private tournament retires its fee and never credits either wallet even with a union value on event');
SELECT assert_true((SELECT balance=3 FROM fixture_banks WHERE bank_kind='union'),'private tournament never credits union rake');
SELECT assert_true((fn_settle_tournament_rake(u(4300),'private-replay')->>'already_settled')::boolean
 AND (SELECT count(*)=1 FROM chip_ledger WHERE from_entity_id=u(4300) AND to_type='chip_retirement')
 AND (SELECT total_rake=1 FROM clubs WHERE id=u(99)), 'standalone retry preserves one retirement and one statistics increment');
SELECT fixture_fee(4350);
UPDATE tournaments SET is_private=true WHERE id=u(4350);
INSERT INTO tournament_rake_settlements(tournament_id,club_id,amount,destination,settled_at,attributed_at,attributed_users)
 VALUES(u(4350),u(99),1,'club_treasury:'||u(99)::text,now(),now(),1);
SELECT assert_sql_refuses('SELECT fn_settle_tournament_rake(u(4350),''legacy-replay'')',
 'tournament_fee_legacy_treasury_leg_requires_adjustment','historical treasury settlement cannot be relabeled or repeated as retirement');


SELECT fixture_fee(4400);
INSERT INTO fixture_tournament_fee_escrow VALUES(u(4400),0.5);
SELECT assert_sql_refuses('SELECT fn_settle_tournament_rake(u(4400),''unfunded'')','fixture_fee_escrow_insufficient','short fee custody cannot be converted into funded rake');
SELECT fixture_fee(4500);
INSERT INTO fixture_tournament_fee_escrow VALUES(u(4500),1);
INSERT INTO accounting_routed_settlement_runs VALUES(u(90),NULL,fn_union_week_start(now()),((fn_union_week_start(now()) AT TIME ZONE 'America/Los_Angeles')+interval '7 days') AT TIME ZONE 'America/Los_Angeles');
SELECT assert_sql_refuses('SELECT fn_settle_tournament_rake(u(4500),''late'')','tournament_accrual_closed_period_requires_adjustment','zero-own completed week still refuses late source accrual');
SELECT assert_true((SELECT balance=1 FROM fixture_tournament_fee_escrow WHERE tournament_id=u(4500)) AND NOT EXISTS(SELECT 1 FROM tournament_rake_settlements WHERE tournament_id=u(4500)),'closed period refusal keeps source fee safely in custody');
DELETE FROM accounting_routed_settlement_runs;

INSERT INTO tournaments(id,club_id,union_id,is_private,tournament_type) VALUES(u(4600),u(99),NULL,false,'MTT');
SELECT set_config('fixture.diamond','true',true);
SELECT assert_true(fn_settle_tournament_rake(u(4600),'diamond')->>'asset'='diamonds','original Diamond branch survives verbatim');
SELECT set_config('fixture.diamond','false',true);
SELECT assert_true(NOT EXISTS(SELECT 1 FROM accounting_tournament_fee_recognitions WHERE tournament_id=u(4600)),'Diamond custody is excluded from chip recognition receipts');
SELECT assert_sql_refuses('INSERT INTO agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,created_at) VALUES(u(21),u(777),1,.25,''tournament_fee_accrual'',u(9876),now())','tournament_commission_recognized_source_required','forged tournament source UUID cannot create commission');
SELECT assert_sql_refuses('INSERT INTO agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,created_at) VALUES(u(21),u(777),1,.25,''tournament_rake_settlement'',u(9876),now())','tournament_commission_requires_canonical_source_writer','legacy commission writer cannot bypass source receipts');
SELECT assert_true(EXISTS(SELECT 1 FROM accounting_period_recompute_requests WHERE club_id=u(21) AND status='pending'),'recognized fee queues the shared weekly period calculation');
SELECT count(*) AS native_assertions FROM assertions;
COMMIT;
