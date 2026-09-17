-- Actual source reader, terminal quality proof, invoice trigger, Messenger and
-- notification bodies run here. Controlled receipts provide the settled-book
-- input; actual R2/R3 money execution is covered by test-routed-accounting.sh.
SELECT assert_true(fn_club_weekly_accounting_summary(u(100))->>'rake_earned'='100','forward upgrade preserves the issued legacy statement basis');
SELECT assert_true(NOT has_function_privilege('service_role','fn_issue_scope_weekly_accounting(text,uuid,timestamptz,timestamptz)','EXECUTE')
 AND NOT has_function_privilege('authenticated','fn_issue_club_weekly_accounting(uuid,timestamptz,timestamptz)','EXECUTE'),'statement issuance stays private behind the coordinator');
INSERT INTO unions VALUES(u(900),'Current Union','10000000-0000-0000-0000-000000000006');
INSERT INTO clubs(id,name,owner_id,union_id) VALUES(u(910),'Departed Club','10000000-0000-0000-0000-000000000001',u(900)),
 (u(911),'Standalone Club','10000000-0000-0000-0000-000000000003',NULL);
INSERT INTO union_clubs VALUES(u(900),u(910));
INSERT INTO settlement_periods(id,club_id,union_id,start_at,end_at,status) VALUES
 (u(920),u(910),'20000000-0000-0000-0000-000000000003','2026-09-07 07:00Z','2026-09-14 07:00Z','settled'),
 (u(921),u(911),NULL,'2026-09-07 07:00Z','2026-09-14 07:00Z','settled'),
 (u(922),u(910),u(900),'2026-09-07 07:00Z','2026-09-14 07:00Z','settled');
UPDATE ca_settlements SET totals=totals||jsonb_build_object('accounting_version',3,
 'basis_by_club',jsonb_build_object('20000000-0000-0000-0000-000000000001',100,u(910)::text,100),
 'payout_by_club',jsonb_build_object('20000000-0000-0000-0000-000000000001',90,u(910)::text,90));
INSERT INTO accounting_cash_rake_sources VALUES
 (u(930),u(940),'10000000-0000-0000-0000-000000000004',u(910),'20000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000003','2026-09-10 12:00Z',100,'{}'),
 (u(931),u(941),'10000000-0000-0000-0000-000000000004',u(910),NULL,'20000000-0000-0000-0000-000000000003','2026-09-10 12:00Z',20,'{}'),
 (u(932),u(942),'10000000-0000-0000-0000-000000000004',u(911),NULL,NULL,'2026-09-10 12:00Z',50,'{}');
INSERT INTO accounting_routed_settlement_runs
 SELECT scope_kind,scope_id,'2026-09-07 07:00Z','2026-09-14 07:00Z',round_no,
 jsonb_build_object('success',true,'routing_version',3,'source_contract_version',3,'scope_kind',scope_kind,'scope_id',scope_id,'shortfalls',0)
 FROM (VALUES('union','20000000-0000-0000-0000-000000000003'::uuid),('club',u(911)))s(scope_kind,scope_id) CROSS JOIN generate_series(2,3)round_no;
INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,settlement_id,created_at)
 VALUES(u(950),'union_wallet','20000000-0000-0000-0000-000000000003','club_treasury',u(910),90,'rakeback',u(910),'20000000-0000-0000-0000-000000000003',u(101)::text,'2026-09-14 07:05Z');
-- Rake-bank journals do not generate invoices (already belong to each hand/event).
INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,created_at)
 VALUES(u(951),'table_stack',u(980),'chip_retirement',NULL,20,'burn',u(910),'2026-09-10 12:00Z'),
 (u(952),'table_stack',u(981),'chip_retirement',NULL,50,'burn',u(911),'2026-09-10 12:00Z');
INSERT INTO accounting_cash_bank_receipts VALUES(u(941),NULL,u(910),NULL,u(951),'2026-09-10 12:00Z',20),(u(942),NULL,u(911),NULL,u(952),'2026-09-10 12:00Z',50);
-- One private tournament, using the actual net-plan and recognition quality proof.
INSERT INTO rake_records VALUES(u(943),u(910),NULL,NULL,u(985),10,true,'{}','2026-09-09 12:00Z','fn_register_for_tournament');
INSERT INTO accounting_tournament_fee_batches SELECT id,tournament_id,fn_accounting_tournament_fee_fingerprint(r),'captured',rake_amount FROM rake_records r WHERE id=u(943);
INSERT INTO accounting_tournament_fee_sources VALUES(u(933),u(943),u(985),'10000000-0000-0000-0000-000000000004',u(910),NULL,'20000000-0000-0000-0000-000000000003','2026-09-09 12:00Z',10,
 jsonb_build_object('player_id','10000000-0000-0000-0000-000000000004','club_id',u(910),'union_id',NULL,'coordinator_union_id','20000000-0000-0000-0000-000000000003','rake_credit',10,'terms_at','2026-09-09 12:00Z'));
INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,created_at)
 VALUES(u(953),'prize_liability',u(985),'chip_retirement',NULL,10,'burn',u(910),'2026-09-10 13:00Z');
INSERT INTO accounting_tournament_fee_recognitions(tournament_id,recognized_at,status,net_rake,union_id,bank_club_id,source_fingerprint,plan,bank_journal_id)
 VALUES(u(985),'2026-09-10 13:00Z','recognized',10,NULL,u(910),fn_accounting_tournament_fee_net_plan(u(985))->>'source_fingerprint','{}',u(953));
INSERT INTO accounting_tournament_recognized_sources VALUES(u(933),u(985),'2026-09-10 13:00Z','earned',10);
INSERT INTO tournament_rake_settlements VALUES(u(985),u(910),NULL,10,'2026-09-10 13:00Z');
INSERT INTO agents(id,user_id,club_id,role) VALUES(u(990),'10000000-0000-0000-0000-000000000002',u(910),'super_agent');
SELECT set_config('app.accounting_routing_context','20000000-0000-0000-0000-000000000003:'||'2026-09-07 07:00Z'::timestamptz::text||':'||'2026-09-14 07:00Z'::timestamptz::text,false);
INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,metadata,created_at)
 VALUES(u(954),'club_treasury',u(910),'player_wallet','10000000-0000-0000-0000-000000000002',40,'commission',u(910),'20000000-0000-0000-0000-000000000003',
 jsonb_build_object('period_start','2026-09-07 07:00Z','period_end','2026-09-14 07:00Z','routing_version',3,'accounting_scope_kind','union','accounting_scope_id','20000000-0000-0000-0000-000000000003','payee_role_at_transfer','super_agent'),'2026-09-14 07:05Z'),
 (u(955),'player_wallet','10000000-0000-0000-0000-000000000002','player_wallet','10000000-0000-0000-0000-000000000004',7,'rakeback',u(910),'20000000-0000-0000-0000-000000000003',
 jsonb_build_object('period_start','2026-09-07 07:00Z','period_end','2026-09-14 07:00Z','routing_version',3,'accounting_scope_kind','union','accounting_scope_id','20000000-0000-0000-0000-000000000003','payee_role_at_transfer','player'),'2026-09-14 07:05Z');
SELECT set_config('app.accounting_routing_context','club:'||u(911)::text||':'||'2026-09-07 07:00Z'::timestamptz::text||':'||'2026-09-14 07:00Z'::timestamptz::text,false);
INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,metadata,created_at)
 VALUES(u(956),'club_treasury',u(911),'player_wallet','10000000-0000-0000-0000-000000000004',5,'rakeback',u(911),
 jsonb_build_object('period_start','2026-09-07 07:00Z','period_end','2026-09-14 07:00Z','routing_version',3,'accounting_scope_kind','club','accounting_scope_id',u(911),'payee_role_at_transfer','player'),'2026-09-14 07:05Z');
SELECT assert_true(fn_club_weekly_accounting_summary(u(920)) @> '{"rake_earned":130,"union_rake_earned":100,"private_rake_earned":30,"rake_received":90,"private_rake_banked":0,"private_rake_burned":30,"total_rake_funding":90,"total_paid_by_club":40,"retained_by_club":50,"paid_super_agents":40,"downstream_redistributed":7,"downstream_paid_players":7,"ready_to_issue":true}',
 'departed club excludes cash retirement from funding and never counts downstream transfers twice');
SELECT assert_true(fn_club_weekly_accounting_summary(u(921)) @> '{"rake_earned":50,"union_rake_earned":0,"private_rake_banked":0,"private_rake_burned":50,"total_rake_funding":0,"rake_received":0,"retained_by_club":-5,"paid_players":5,"ready_to_issue":true}',
 'standalone cash burn is not funding; actual payouts use pre-existing treasury and preserve the signed net');
BEGIN;
UPDATE clubs SET union_id=u(900) WHERE id=u(911);
SELECT assert_true(fn_club_weekly_accounting_summary(u(921))->>'ready_to_issue'='true','joining a union later does not move the standalone earning week');
ROLLBACK;
BEGIN;
UPDATE chip_ledger SET metadata=metadata||'{"period_start":"invalid"}' WHERE id=u(956);
SELECT assert_true(fn_club_weekly_accounting_summary(u(921))->>'ready_to_issue'='false','malformed earning-period metadata remains a visible reconciliation failure');
ROLLBACK;
SELECT assert_true(fn_club_weekly_accounting_summary(u(920))->>'status'='needs_reconciliation','uncommitted coordinator completion is not claimed by the preview');
BEGIN;
UPDATE chip_ledger SET to_type='club_treasury',to_entity_id=u(911),category='rake' WHERE id=u(952);
SELECT assert_true(fn_club_weekly_accounting_summary(u(921))->>'ready_to_issue'='false',
 'historical treasury credit is not a retirement receipt and cannot certify this standalone week');
ROLLBACK;
SELECT set_config('test.engine','false',false),set_config('test.uid','10000000-0000-0000-0000-000000000001',false);
SELECT assert_true(fn_club_weekly_accounting_summary(u(920))->>'private_rake_burned'='30','authorized owner reads the same unissued source proof');
SELECT assert_true(refuses($$SELECT fn_club_weekly_accounting_summary(u(921))$$,'42501'),'another club owner cannot read standalone figures');
SELECT set_config('test.uid','10000000-0000-0000-0000-000000000006',false);
SELECT assert_true(refuses($$SELECT fn_club_weekly_accounting_summary(u(920))$$,'42501'),'current union owner cannot read the departed club historical union book');
SELECT set_config('test.engine','true',false);
SELECT assert_true(refuses($$SELECT fn_issue_scope_weekly_accounting('club',u(911),'2026-09-07 07:00Z','2026-09-14 07:00Z')$$,'23514'),'generic issuer refuses without exact coordinator context');
SELECT set_config('app.accounting_validated_scope','club:'||u(910)::text||':'||'2026-09-07 07:00Z'::timestamptz::text||':'||'2026-09-14 07:00Z'::timestamptz::text,false);
SELECT assert_true(refuses($$SELECT fn_issue_scope_weekly_accounting('club',u(911),'2026-09-07 07:00Z','2026-09-14 07:00Z')$$,'23514'),'wrong club validated context cannot publish another club book');
BEGIN;
UPDATE accounting_cash_bank_receipts SET amount=19 WHERE rake_record_id=u(941);
SELECT assert_true(fn_club_weekly_accounting_summary(u(920))->>'ready_to_issue'='false','private source bank amount disagreement prevents publication');
ROLLBACK;
BEGIN;
UPDATE chip_ledger SET to_entity_id=u(911) WHERE id=u(951);
SELECT assert_true(fn_club_weekly_accounting_summary(u(920))->>'ready_to_issue'='false','a cash retirement cannot name a receiving wallet or be counted as funding');
ROLLBACK;
BEGIN;
UPDATE accounting_tournament_fee_recognitions SET status='banked_accrual_deferred' WHERE tournament_id=u(985);
SELECT assert_true(fn_club_weekly_accounting_summary(u(920))->>'ready_to_issue'='false','deferred terminal recognition blocks the statement');
ROLLBACK;
BEGIN;
DELETE FROM accounting_routed_settlement_runs WHERE scope_kind='club' AND round_no=3;
SELECT assert_true(fn_club_weekly_accounting_summary(u(921))->>'ready_to_issue'='false','missing stage receipt prevents an apparently funded week being called finished');
ROLLBACK;
BEGIN;
UPDATE chip_ledger SET union_id=u(900) WHERE id=u(954);
SELECT assert_true(fn_club_weekly_accounting_summary(u(920))->>'total_paid_by_club'='0','same-week another recorded union journal is excluded');
ROLLBACK;
-- Failed notification delivery rolls every newly issued statement back.
SELECT set_config('app.accounting_validated_scope','preserve-me',false),set_config('test.fail_weekly','true',false);
SELECT assert_true(refuses($$SELECT fn_issue_club_weekly_accounting('20000000-0000-0000-0000-000000000003','2026-09-07 07:00Z','2026-09-14 07:00Z')$$,'P0001'),'union wrapper propagates real notification failure atomically');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM settlement_invoices WHERE period_id=u(920)),'failed union publication leaves no departed-club statement');
SELECT assert_true(current_setting('app.accounting_validated_scope')='preserve-me','exception rollback restores the previous validated scope');
SELECT set_config('test.fail_weekly','false',false);
CREATE TEMP TABLE union_issue_result AS SELECT fn_issue_club_weekly_accounting('20000000-0000-0000-0000-000000000003','2026-09-07 07:00Z','2026-09-14 07:00Z') result;
SELECT assert_true((SELECT result @> '{"success":true,"clubs":2,"issued":1}' FROM union_issue_result),'union publishes the departed club without joining current union_clubs');
SELECT assert_true(current_setting('app.accounting_validated_scope')='preserve-me','successful union wrapper restores prior scoped context');
SELECT set_config('app.accounting_validated_scope','club:'||u(911)::text||':'||'2026-09-07 07:00Z'::timestamptz::text||':'||'2026-09-14 07:00Z'::timestamptz::text,false);
CREATE TEMP TABLE standalone_issue_result AS SELECT fn_issue_scope_weekly_accounting('club',u(911),'2026-09-07 07:00Z','2026-09-14 07:00Z') result;
SELECT assert_true((SELECT result @> '{"success":true,"clubs":1,"issued":1}' FROM standalone_issue_result),'standalone publishes through the same invoice and delivery function');
SELECT assert_true((SELECT count(*)=2 FROM settlement_invoices WHERE period_id IN(u(920),u(921))) AND (SELECT count(*)=2 FROM accounting_invoice_deliveries d JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.period_id IN(u(920),u(921))),'one weekly statement and one real recipient delivery per club');
SELECT assert_true((SELECT bool_and(m.content LIKE '%Private Rake Banked:%' AND m.content LIKE '%Total Rake Funding:%') FROM social_messages m JOIN accounting_invoice_deliveries d ON d.message_id=m.id JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.period_id IN(u(920),u(921))),'actual weekly Messenger documents show the private funding line explicitly');
SELECT assert_true(fn_issue_scope_weekly_accounting('club',u(911),'2026-09-07 07:00Z','2026-09-14 07:00Z')->>'issued'='0','repeat standalone close does not issue another document');
BEGIN;
UPDATE accounting_cash_rake_sources SET rake_credit=500 WHERE id=u(932);
SELECT assert_true(fn_club_weekly_accounting_summary(u(921))->>'private_rake_burned'='50','issued standalone basis stays frozen after later source changes');
ROLLBACK;
BEGIN;
INSERT INTO settlement_periods(id,club_id,union_id,start_at,end_at,status) VALUES(u(999),u(911),NULL,'2026-09-07 07:00Z','2026-09-14 07:00Z','settled');
SELECT assert_true(refuses($$SELECT fn_issue_scope_weekly_accounting('club',u(911),'2026-09-07 07:00Z','2026-09-14 07:00Z')$$,'23514'),'ambiguous duplicate standalone periods cannot publish or silently select a row');
ROLLBACK;

INSERT INTO clubs(id,name,owner_id,union_id) VALUES(u(912),'Former Zero Earnings Club','10000000-0000-0000-0000-000000000006',NULL),
 (u(913),'New This Monday','10000000-0000-0000-0000-000000000006','20000000-0000-0000-0000-000000000003');
INSERT INTO union_clubs VALUES('20000000-0000-0000-0000-000000000003',u(913));
INSERT INTO accounting_agreement_history VALUES(1,u(912)::text,'union_clubs','2026-09-06',jsonb_build_object('club_id',u(912),'union_id','20000000-0000-0000-0000-000000000003')),
 (2,u(912)::text,'union_clubs','2026-09-13','null'),
 (3,u(913)::text,'union_clubs','2026-09-14 08:00Z',jsonb_build_object('club_id',u(913),'union_id','20000000-0000-0000-0000-000000000003'));
SELECT assert_true((SELECT array_agg(club_id ORDER BY club_id) @> ARRAY[u(912)] AND NOT array_agg(club_id ORDER BY club_id) @> ARRAY[u(913)] FROM fn_accounting_week_clubs('20000000-0000-0000-0000-000000000003',NULL,'2026-09-07 07:00Z','2026-09-14 07:00Z')),
 'actual historical scope helper includes a departed zero-source club and excludes a club first joining after the week');
SELECT assert_true(refuses($$SELECT fn_issue_club_weekly_accounting('20000000-0000-0000-0000-000000000003','2026-09-07 07:00Z','2026-09-14 07:00Z')$$,'23514'),'missing historical club period cannot silently reduce statement coverage');
SELECT fn_mark_scope_accounting_settled('union','20000000-0000-0000-0000-000000000003','2026-09-07 07:00Z','2026-09-14 07:00Z');
SELECT assert_true((SELECT count(*)=1 AND bool_and(period_number=37 AND year=2026 AND status='settled') FROM settlement_periods WHERE club_id=u(912)),
 'actual coordinator period creator writes one settled historical club week using Pacific ISO year and week');
SELECT assert_true((SELECT fn_club_weekly_accounting_summary(id) @> '{"rake_earned":0,"total_rake_funding":0,"retained_by_club":0,"ready_to_issue":true}' FROM settlement_periods WHERE club_id=u(912)),
 'certified zero-source club has an explicit zero weekly statement');
