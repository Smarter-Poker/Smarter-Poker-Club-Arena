-- Owner accounting notifications must never buzz the owner's phone: they are
-- the owner account's issuer-side owner/union-owner copy of a receipt someone
-- else already got pushed. Added alongside
-- 20260927143752_owner_accounting_notifications_routed_to_production_alerts.sql,
-- extended by 20260928032225_owner_accounting_alerts_carry_the_fleet_address.sql:
-- the hour's event is addressed to the Production Alerts fleet, the store
-- refuses an unaddressed row under the source, and a refused recording reaches
-- the fleet as its own addressed row.
--
-- The store is production's, installed verbatim by operational-alert-store.sql
-- before 20260927143752 runs (scripts/dev/test-accounting-push-bridge.sh).
-- This file lives under scripts/dev/ because scripts/ci/classify-ci-changes.mjs
-- sends a change there to the accounting job, and does not send
-- tests/fixtures/accounting-push/; its sha256 is pinned in
-- tests/an-operational-alert-sender-addresses-the-fleet.law.test.ts.

-- (1) An owner-recipient accounting notification still gets its durable
-- push_outbox receipt (the 20260914141405 invariant), but skipped -- never
-- claimable by claim_push_outbox_batch -- and coalesced into one Production
-- Alerts info event instead.
SELECT fixture_transfer(u(910),'20000000-0000-0000-0000-000000000001','47965354-0e56-43ef-931c-ddaab82af765','20000000-0000-0000-0000-000000000001');
SELECT assert_true((SELECT count(*)=1 FROM push_outbox p JOIN accounting_invoice_deliveries d ON d.notification_id=p.accounting_notification_id JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=u(910) AND p.status='skipped' AND p.failure_reason='owner_accounting_routed_to_production_alerts'),'owner-recipient accounting notification is a skipped durable receipt, not a device push');
SELECT assert_true((SELECT count(*)=1 FROM operational_alert_events WHERE source='owner-accounting-notifications' AND status='info' AND severity='info'),'owner accounting notification is coalesced into one Production Alerts info event');
SELECT assert_true((SELECT delivery_count FROM operational_alert_events WHERE source='owner-accounting-notifications')=1,'first owner accounting notification of the hour starts delivery_count at one');
-- FAILING BEFORE / PASSING AFTER 20260928032225: the fleet triages
-- operational_alert_events by payload.target_task_id, and the writer sets
-- payload only on the hour's first insert, so the first call must already
-- carry the fleet address.
SELECT assert_true((SELECT payload->>'target_task_id' FROM operational_alert_events WHERE source='owner-accounting-notifications')='01a09b86-5ba8-7290-8657-1041f13dd3ca','owner accounting Production Alerts event carries payload.target_task_id for the fleet lane');

-- (2) A second owner-recipient notification in the same hour coalesces onto
-- the same informational event instead of flooding the inbox, and still gets
-- its own durable, skipped outbox receipt (one row per notification).
SELECT fixture_transfer(u(911),'20000000-0000-0000-0000-000000000001','47965354-0e56-43ef-931c-ddaab82af765','20000000-0000-0000-0000-000000000001');
SELECT assert_true((SELECT count(*)=1 FROM push_outbox p JOIN accounting_invoice_deliveries d ON d.notification_id=p.accounting_notification_id JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=u(911) AND p.status='skipped' AND p.failure_reason='owner_accounting_routed_to_production_alerts'),'second owner accounting notification in the same hour is also its own skipped durable receipt');
SELECT assert_true((SELECT count(*) FROM operational_alert_events WHERE source='owner-accounting-notifications')=1,'still exactly one Production Alerts row for the hour, not one per receipt');
SELECT assert_true((SELECT delivery_count FROM operational_alert_events WHERE source='owner-accounting-notifications')=2,'delivery_count becomes the hour''s receipt count instead of a new row per receipt');

-- (3) A non-owner payee's accounting notification is completely unaffected:
-- it still becomes a pending device push.
SELECT fixture_transfer(u(912),'20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000001');
SELECT assert_true((SELECT count(*)=1 FROM push_outbox p JOIN accounting_invoice_deliveries d ON d.notification_id=p.accounting_notification_id JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=u(912) AND p.status='pending'),'non-owner payee keeps their own accounting push exactly as before');

-- (4) Cashier post-check interaction: the cashier_cashout/accounting_correction/
-- credit_limit_change content post-check must compare the outbox row against
-- the state/reason this branch chose, so an owner-recipient cashier document
-- (skipped, owner-routed) still passes instead of raising
-- cashier_push_receipt_missing. Issued invoices are immutable, so this is
-- asserted on the installed body rather than by rewriting an invoice's type.
SELECT assert_true(pg_get_functiondef('public.fn_mirror_notification_to_push_outbox()'::regprocedure) LIKE
  '%AND o.status=state AND o.failure_reason IS NOT DISTINCT FROM reason%'
  AND pg_get_functiondef('public.fn_mirror_notification_to_push_outbox()'::regprocedure) LIKE
  '%state:=''skipped'';reason:=''owner_accounting_routed_to_production_alerts'';%',
  'cashier post-check compares against the owner-routed state and reason this branch sets');

-- (5) A Production Alerts write failure can never roll back the financial
-- document: with the store refusing every row under the source (the hour's
-- event and the failure row of (6) alike), the invoice, Messenger message and
-- durable outbox receipt still all commit, and nothing is stored for it.
ALTER TABLE operational_alert_events ADD CONSTRAINT fixture_store_refuses_the_source CHECK (source<>'owner-accounting-notifications') NOT VALID;
SELECT fixture_transfer(u(914),'20000000-0000-0000-0000-000000000001','47965354-0e56-43ef-931c-ddaab82af765','20000000-0000-0000-0000-000000000001');
ALTER TABLE operational_alert_events DROP CONSTRAINT fixture_store_refuses_the_source;
SELECT assert_true((SELECT count(*)=1 FROM push_outbox p JOIN accounting_invoice_deliveries d ON d.notification_id=p.accounting_notification_id JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=u(914) AND p.status='skipped' AND p.failure_reason='owner_accounting_routed_to_production_alerts'),'Production Alerts write failure does not stop the durable receipt from being written');
SELECT assert_true(EXISTS(SELECT 1 FROM settlement_invoices i WHERE i.source_ledger_id=u(914)) AND EXISTS(SELECT 1 FROM social_messages sm JOIN accounting_invoice_deliveries d ON d.message_id=sm.id JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=u(914)),'invoice and Messenger message still commit when the Production Alerts write fails');
SELECT assert_true((SELECT sum(delivery_count)=2 FROM operational_alert_events WHERE source='owner-accounting-notifications' AND event_key LIKE 'owner-accounting:%') AND NOT EXISTS(SELECT 1 FROM operational_alert_events WHERE event_key LIKE 'owner-accounting-unstored:%'),'a store that refuses everything stores nothing for that notification, and the document still commits');

-- (6) FAILING BEFORE / PASSING AFTER 20260928032225: when the store refuses
-- the hour's event but can take a row, the fleet hears about it - one
-- addressed firing row for the hour under the same source, naming the SQLSTATE
-- and constraint - and the notification keeps the same skipped, owner-routed
-- receipt. Before, the handler only raised a WARNING, which reaches nobody.
ALTER TABLE operational_alert_events ADD CONSTRAINT fixture_store_refuses_the_info_event CHECK (NOT (source='owner-accounting-notifications' AND status='info')) NOT VALID;
SELECT fixture_transfer(u(915),'20000000-0000-0000-0000-000000000001','47965354-0e56-43ef-931c-ddaab82af765','20000000-0000-0000-0000-000000000001');
ALTER TABLE operational_alert_events DROP CONSTRAINT fixture_store_refuses_the_info_event;
SELECT assert_true((SELECT count(*)=1 FROM push_outbox p JOIN accounting_invoice_deliveries d ON d.notification_id=p.accounting_notification_id JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=u(915) AND p.status='skipped' AND p.failure_reason='owner_accounting_routed_to_production_alerts'),'a refused Production Alerts recording leaves the same skipped, owner-routed receipt');
SELECT assert_true((SELECT count(*)=1 FROM operational_alert_events e WHERE e.source='owner-accounting-notifications' AND e.event_key LIKE 'owner-accounting-unstored:%'
  AND e.alertname='Owner Accounting Alert Not Stored' AND e.status='firing' AND e.severity='warning'
  AND e.payload->>'target_task_id'='01a09b86-5ba8-7290-8657-1041f13dd3ca' AND e.payload->>'sqlstate'='23514'
  AND e.payload->>'constraint'='fixture_store_refuses_the_info_event'
  AND e.payload->>'unstored_event_key'=replace(e.event_key,'owner-accounting-unstored:','owner-accounting:')
  AND e.payload->>'first_notification_id'=(SELECT p.accounting_notification_id::text FROM push_outbox p JOIN accounting_invoice_deliveries d ON d.notification_id=p.accounting_notification_id JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=u(915) AND p.failure_reason='owner_accounting_routed_to_production_alerts')),
  'a refused owner accounting recording reaches the fleet as one addressed row naming its SQLSTATE and constraint');

-- (7) FAILING BEFORE / PASSING AFTER 20260928032225: the store itself refuses
-- an unaddressed row under the source, whoever writes it - the writer, the
-- batch writer, a direct INSERT, or an UPDATE that strips the key - and a
-- payload WITHOUT the key is refused too (a CHECK passes on NULL, which is why
-- the rule is IS NOT DISTINCT FROM and not =).
SELECT assert_true(EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='operational_alert_events'::regclass AND conname='operational_alert_events_owner_accounting_addressed' AND contype='c' AND convalidated),'the store carries a validated rule for the owner accounting source');
SELECT assert_true(refuses($$SELECT fn_record_operational_alert('owner-accounting-notifications','fixture-probe:absent','Probe','info','info','{"k":1}'::jsonb)$$,'23514'),'the writer cannot store an owner accounting row without target_task_id');
SELECT assert_true(refuses($$SELECT fn_record_operational_alert('owner-accounting-notifications','fixture-probe:null','Probe','info','info',jsonb_build_object('target_task_id',NULL))$$,'23514'),'nor with a NULL target_task_id');
SELECT assert_true(refuses($$SELECT fn_record_operational_alert('owner-accounting-notifications','fixture-probe:other','Probe','info','info',jsonb_build_object('target_task_id','00000000-0000-4000-8000-000000000000'))$$,'23514'),'nor addressed to another task');
SELECT assert_true(refuses($$SELECT fn_record_operational_alert('owner-accounting-notifications','fixture-probe:upper','Probe','info','info',jsonb_build_object('target_task_id',upper('01a09b86-5ba8-7290-8657-1041f13dd3ca')))$$,'23514'),'nor addressed in a spelling the fleet does not read');
SELECT assert_true(refuses($$SELECT fn_record_operational_alerts('[{"source":"owner-accounting-notifications","event_key":"fixture-probe:batch","alertname":"Probe","status":"info","severity":"info","payload":{}}]'::jsonb)$$,'23514'),'the batch writer cannot store one either');
SELECT assert_true(refuses($$INSERT INTO operational_alert_events(source,event_key,alertname,status,severity,payload) VALUES('owner-accounting-notifications','fixture-probe:direct','Probe','info','info','{"k":1}')$$,'23514'),'nor can a direct INSERT');
SELECT assert_true(refuses($$UPDATE operational_alert_events SET payload=payload-'target_task_id' WHERE source='owner-accounting-notifications'$$,'23514'),'nor can an UPDATE that strips the address from a stored row');
-- Narrow on purpose: every other source writes exactly as before, including the
-- writer's ON CONFLICT update and the fleet's triage of an unaddressed row.
SELECT fn_record_operational_alert('fixture-other-source','fixture-probe:unaddressed','Probe','firing','warning','{}'::jsonb);
SELECT fn_record_operational_alert('fixture-other-source','fixture-probe:unaddressed','Probe','firing','warning','{}'::jsonb);
UPDATE operational_alert_events SET investigation_status='investigating',investigation='{"lane":"fixture"}' WHERE source='fixture-other-source';
SELECT assert_true((SELECT delivery_count=2 AND investigation_status='investigating' FROM operational_alert_events WHERE source='fixture-other-source'),'another source''s unaddressed row is still stored, coalesced and triaged');
SELECT assert_true(fn_record_operational_alert('owner-accounting-notifications','fixture-probe:addressed','Probe','info','info',jsonb_build_object('target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca')) IS NOT NULL,'an addressed row under the source is stored');
DELETE FROM operational_alert_events WHERE event_key LIKE 'fixture-probe:%';

-- (8) FAILING BEFORE / PASSING AFTER 20260928032225: a later body that loses
-- the address (the #5489 shape rebuilt without the key) cannot land an
-- unaddressed row. The store refuses the hour's event, the fleet gets the
-- failure row naming the store's rule, and the push decision is unchanged.
CREATE TABLE fixture_mirror_body AS SELECT pg_get_functiondef('public.fn_mirror_notification_to_push_outbox()'::regprocedure) AS def;
DO $$
DECLARE def text:=(SELECT b.def FROM fixture_mirror_body b); variant text;
BEGIN
  variant:=replace(def,'jsonb_build_object(''target_task_id'',''01a09b86-5ba8-7290-8657-1041f13dd3ca'',''first_notification_id''','jsonb_build_object(''first_notification_id''');
  PERFORM assert_true(variant<>def,'the installed body addresses its hourly event, so a copy without the address can be made');
  EXECUTE variant;
END $$;
DELETE FROM operational_alert_events WHERE source='owner-accounting-notifications';
SELECT fixture_transfer(u(916),'20000000-0000-0000-0000-000000000001','47965354-0e56-43ef-931c-ddaab82af765','20000000-0000-0000-0000-000000000001');
DO $$BEGIN EXECUTE (SELECT b.def FROM fixture_mirror_body b); END$$;
SELECT assert_true(md5(pg_get_functiondef('public.fn_mirror_notification_to_push_outbox()'::regprocedure))=(SELECT md5(b.def) FROM fixture_mirror_body b),'the installed body is restored after the unaddressed copy');
SELECT assert_true((SELECT count(*)=1 FROM push_outbox p JOIN accounting_invoice_deliveries d ON d.notification_id=p.accounting_notification_id JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=u(916) AND p.status='skipped' AND p.failure_reason='owner_accounting_routed_to_production_alerts'),'a body that lost the address still makes the same push decision');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM operational_alert_events WHERE source='owner-accounting-notifications' AND event_key LIKE 'owner-accounting:%'),'the store refuses the unaddressed hourly event');
SELECT assert_true((SELECT count(*)=1 FROM operational_alert_events e WHERE e.source='owner-accounting-notifications' AND e.event_key LIKE 'owner-accounting-unstored:%'
  AND e.payload->>'target_task_id'='01a09b86-5ba8-7290-8657-1041f13dd3ca' AND e.payload->>'sqlstate'='23514'
  AND e.payload->>'constraint'='operational_alert_events_owner_accounting_addressed'
  AND e.payload->>'first_notification_id'=(SELECT p.accounting_notification_id::text FROM push_outbox p JOIN accounting_invoice_deliveries d ON d.notification_id=p.accounting_notification_id JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=u(916) AND p.failure_reason='owner_accounting_routed_to_production_alerts')),
  'the fleet is told, addressed, that the hour''s owner accounting event could not be stored');

-- Whatever the hour or the receipt count, no row under this source is ever
-- written without the fleet address.
SELECT assert_true(NOT EXISTS(SELECT 1 FROM operational_alert_events WHERE source='owner-accounting-notifications' AND payload->>'target_task_id' IS DISTINCT FROM '01a09b86-5ba8-7290-8657-1041f13dd3ca'),'no owner accounting Production Alerts row is ever unaddressed');

SELECT assert_true(NOT EXISTS(SELECT 1 FROM push_outbox WHERE accounting_notification_id IN (
  SELECT d.notification_id FROM accounting_invoice_deliveries d JOIN settlement_invoices i ON i.id=d.invoice_id
  WHERE i.source_ledger_id IN (u(910),u(911),u(914),u(915),u(916))
) AND status='sent'),'no owner-recipient accounting notification is ever sent as a device push');
