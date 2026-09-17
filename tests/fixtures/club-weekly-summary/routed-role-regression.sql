SELECT set_config('test.engine','true',false);
SELECT set_config('app.accounting_routing_context','30000000-0000-0000-0000-000000000001:2026-09-07 07:00:00+00:2026-09-14 07:00:00+00',false);
SET timezone='UTC';
-- Existing agent identity is deliberately paid as a player on this recorded leg.
INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,metadata)
 VALUES(u(950),'club_treasury','20000000-0000-0000-0000-000000000001','player_wallet','10000000-0000-0000-0000-000000000002',1.25,'rakeback','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
 jsonb_build_object('routing_version',3,'payee_role_at_transfer','player','period_start','2026-09-07T07:00:00Z','period_end','2026-09-14T07:00:00Z'));
SELECT assert_true((SELECT to_entity_type='player' AND breakdown->>'payee_role_at_transfer'='player' FROM settlement_invoices WHERE source_ledger_id=u(950)),'routed player rakeback stays a player document even with an agent profile');
UPDATE agents SET role='super_agent' WHERE user_id='10000000-0000-0000-0000-000000000002';
INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,metadata)
 VALUES(u(951),'club_treasury','20000000-0000-0000-0000-000000000001','player_wallet','10000000-0000-0000-0000-000000000002',2.25,'commission','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
 jsonb_build_object('routing_version',3,'payee_role_at_transfer','sub_agent','period_start','2026-09-07T07:00:00Z','period_end','2026-09-14T07:00:00Z'));
SELECT assert_true((SELECT to_entity_type='agent' AND breakdown->>'payee_role_at_transfer'='sub_agent' FROM settlement_invoices WHERE source_ledger_id=u(951)),'invoice retains the recorded tier after a current role change');
SELECT set_config('app.accounting_routing_context','',false);
INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,metadata)
 VALUES(u(952),'club_treasury','20000000-0000-0000-0000-000000000001','player_wallet','10000000-0000-0000-0000-000000000002',3.25,'commission','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
 jsonb_build_object('routing_version',3,'payee_role_at_transfer','player','period_start','2026-09-07T07:00:00Z','period_end','2026-09-14T07:00:00Z'));
SELECT assert_true((SELECT to_entity_type='agent' AND breakdown->>'payee_role_at_transfer'='super_agent' FROM settlement_invoices WHERE source_ledger_id=u(952)),'untrusted metadata cannot assert a private routed role');
SELECT assert_true((SELECT count(*)=3 FROM settlement_invoices WHERE source_ledger_id IN(u(950),u(951),u(952))),'each positive role-specific payment still issues exactly one source invoice');
