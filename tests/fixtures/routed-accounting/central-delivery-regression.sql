BEGIN;
SET LOCAL app.accounting_routing_context='caller-context';
-- Current profile roles differ; recorded accounting roles must survive. A player can also be an agent.
UPDATE agents SET role='agent';
INSERT INTO agents VALUES(u(104),u(11),u(301),'super_agent',NULL,.1,'active');
SELECT run_all();
SELECT assert_true((SELECT count(*) FROM chip_ledger)=6 AND (SELECT count(*) FROM settlement_invoices)=6
 AND (SELECT count(*) FROM accounting_invoice_deliveries)=10 AND (SELECT count(*) FROM social_messages)=10
 AND (SELECT count(*) FROM notifications)=10,'real routed stage produces one source invoice and exact private message/notification deliveries for every transfer');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM accounting_invoice_deliveries WHERE recipient_id=u(901))
 AND NOT EXISTS(SELECT 1 FROM notifications WHERE user_id=u(901)),'club managers receive no individual waterfall delivery or notification');
SELECT assert_true((SELECT to_entity_type FROM settlement_invoices WHERE to_entity_id=u(301)::text)='player'
 AND (SELECT invoice_type FROM settlement_invoices WHERE to_entity_id=u(301)::text)='agent_to_player','a rakeback player with an agent profile remains a player on the real invoice');
SELECT assert_true((SELECT breakdown->>'payee_role_at_transfer' FROM settlement_invoices WHERE to_entity_id=u(203)::text)='super_agent'
 AND (SELECT breakdown->>'payee_role_at_transfer' FROM settlement_invoices WHERE to_entity_id=u(201)::text)='sub_agent','real invoice publisher trusts the historical payee role only during the private stage');
SELECT assert_true(current_setting('app.accounting_routing_context')='caller-context','real delivery preserves the caller routing context after both stages');
SELECT assert_true(run2()->>'duplicate'='true' AND run3()->>'duplicate'='true'
 AND (SELECT count(*) FROM settlement_invoices)=6 AND (SELECT count(*) FROM accounting_invoice_deliveries)=10,'repeated full stages cannot create or deliver a second real document');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM accounting_invoice_deliveries d JOIN settlement_invoices i ON i.id=d.invoice_id JOIN social_messages m ON m.id=d.message_id JOIN notifications n ON n.id=d.notification_id WHERE m.message_type<>'invoice' OR m.media_metadata->>'source_ledger_id' IS DISTINCT FROM i.source_ledger_id::text OR n.data->>'source_ledger_id' IS DISTINCT FROM i.source_ledger_id::text OR n.user_id<>d.recipient_id),'real messages and notifications preserve the exact posted source and recipient');
SELECT assert_true(refuses('UPDATE settlement_invoices SET net_amount=net_amount+1','issued_accounting_invoice_is_immutable') AND refuses('UPDATE social_messages SET content=''changed''','issued_accounting_message_is_immutable'),'issued financial documents and their real Messenger bodies cannot be rewritten');
SELECT assert_true(refuses('INSERT INTO social_conversation_participants SELECT conversation_id,u(303),NULL,NULL FROM accounting_conversations WHERE recipient_id=u(301) LIMIT 1','accounting_conversation_audience_is_immutable'),'an outsider cannot be appended to a real accounting conversation');
ROLLBACK;
BEGIN;
SET LOCAL test.delivery_failure='rakeback';
SELECT assert_true(refuses('SELECT run_all()','test real notification failure'),'failure in actual notification delivery aborts the combined waterfall');
SELECT assert_true((SELECT chip_treasury FROM clubs)=200 AND (SELECT sum(chip_balance) FROM club_members)=0
 AND NOT EXISTS(SELECT 1 FROM chip_ledger) AND NOT EXISTS(SELECT 1 FROM settlement_invoices)
 AND NOT EXISTS(SELECT 1 FROM social_messages) AND NOT EXISTS(SELECT 1 FROM notifications)
 AND NOT EXISTS(SELECT 1 FROM accounting_conversations) AND NOT EXISTS(SELECT 1 FROM social_conversation_participants)
 AND NOT EXISTS(SELECT 1 FROM accounting_routed_settlement_runs) AND NOT EXISTS(SELECT 1 FROM rakeback_period_payouts)
 AND NOT EXISTS(SELECT 1 FROM agent_commission_settlements),'real downstream notification failure rolls back all money, earlier documents, private conversations and completion markers');
ROLLBACK;
BEGIN;
-- Metadata alone has no role authority outside the matching private transaction context.
INSERT INTO chip_ledger(from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,metadata)
 VALUES('club_treasury',u(11),'player_wallet',u(201),1,'commission',u(11),u(1),jsonb_build_object('routing_version',3,'payee_role_at_transfer','player','period_start','2026-09-07T07:00:00Z','period_end','2026-09-14T07:00:00Z'));
SELECT assert_true((SELECT to_entity_type FROM settlement_invoices)='agent' AND (SELECT breakdown->>'payee_role_at_transfer' FROM settlement_invoices)='sub_agent','arbitrary routing metadata cannot relabel the recipient on a real document');
ROLLBACK;

CREATE FUNCTION run_standalone() RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE a jsonb;b jsonb;BEGIN
 a:=fn_settle_accounting_commission_stage('club',u(11),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z');
 b:=fn_settle_accounting_rakeback_stage('club',u(11),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z');
 RETURN jsonb_build_object('r2',a,'r3',b);END$$;
BEGIN;
UPDATE accounting_cash_rake_sources SET coordinator_union_id=NULL,union_id=NULL;
UPDATE accounting_rakeback_period_calculations SET coordinator_union_id=NULL;
UPDATE agents SET role='agent';
INSERT INTO agents VALUES(u(104),u(11),u(301),'super_agent',NULL,.1,'active');
SET LOCAL app.accounting_routing_context='standalone-real-caller';
SELECT run_standalone();
SELECT assert_true((SELECT count(*) FROM settlement_invoices)=6 AND (SELECT count(*) FROM accounting_invoice_deliveries)=10
 AND NOT EXISTS(SELECT 1 FROM accounting_invoice_deliveries WHERE recipient_id=u(901)),'standalone shared stages issue the same real private receipts without individual club deliveries');
SELECT assert_true((SELECT to_entity_type FROM settlement_invoices WHERE to_entity_id=u(301)::text)='player'
 AND (SELECT breakdown->>'payee_role_at_transfer' FROM settlement_invoices WHERE to_entity_id=u(203)::text)='super_agent'
 AND (SELECT breakdown->>'payee_role_at_transfer' FROM settlement_invoices WHERE to_entity_id=u(201)::text)='sub_agent','standalone real receipts preserve earning-time agent roles and player identity despite current profile changes');
SELECT assert_true(current_setting('app.accounting_routing_context')='standalone-real-caller'
 AND (SELECT bool_and(value->>'duplicate'='true') FROM jsonb_each(run_standalone()))
 AND (SELECT count(*) FROM accounting_invoice_deliveries)=10,'standalone real delivery restores caller context and replays without additional documents');
ROLLBACK;
BEGIN;
SELECT set_config('app.accounting_routing_context','club:'||u(12)::text||':2026-09-07 07:00:00+00:2026-09-14 07:00:00+00',true);
INSERT INTO chip_ledger(from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,metadata)
 VALUES('club_treasury',u(11),'player_wallet',u(201),1,'commission',u(11),jsonb_build_object('routing_version',3,'accounting_scope_kind','club','accounting_scope_id',u(11),'payee_role_at_transfer','player','period_start','2026-09-07T07:00:00Z','period_end','2026-09-14T07:00:00Z'));
SELECT assert_true((SELECT to_entity_type FROM settlement_invoices)='agent' AND (SELECT breakdown->>'payee_role_at_transfer' FROM settlement_invoices)='sub_agent','another club routing context cannot relabel this standalone receipt');
ROLLBACK;
BEGIN;
SELECT set_config('app.accounting_routing_context','club:'||u(11)::text||':2026-09-07 07:00:00+00:2026-09-14 07:00:00+00',true);
INSERT INTO chip_ledger(from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,metadata)
 VALUES('club_treasury',u(11),'player_wallet',u(201),1,'commission',u(11),jsonb_build_object('routing_version',3,'accounting_scope_kind','club','accounting_scope_id',u(12),'payee_role_at_transfer','player','period_start','2026-09-07T07:00:00Z','period_end','2026-09-14T07:00:00Z'));
SELECT assert_true((SELECT to_entity_type FROM settlement_invoices)='agent','mismatched standalone metadata scope cannot assert historical recipient role');
ROLLBACK;
BEGIN;
UPDATE accounting_cash_rake_sources SET coordinator_union_id=NULL,union_id=NULL;
UPDATE accounting_rakeback_period_calculations SET coordinator_union_id=NULL;
SET LOCAL test.delivery_failure='rakeback';
SELECT assert_true(refuses('SELECT run_standalone()','test real notification failure')
 AND (SELECT chip_treasury FROM clubs)=200 AND NOT EXISTS(SELECT 1 FROM settlement_invoices)
 AND NOT EXISTS(SELECT 1 FROM social_messages) AND NOT EXISTS(SELECT 1 FROM notifications)
 AND NOT EXISTS(SELECT 1 FROM chip_ledger) AND NOT EXISTS(SELECT 1 FROM accounting_routed_settlement_runs),'standalone real notification failure atomically reverses both payment rounds and all documents');
ROLLBACK;
