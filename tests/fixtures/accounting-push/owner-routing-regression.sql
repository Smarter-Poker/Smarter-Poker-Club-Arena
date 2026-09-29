-- Owner accounting notifications must never buzz Dan's phone: they are his
-- issuer-side owner/union-owner copy of a receipt someone else already got
-- pushed. Added alongside
-- 20260927143752_owner_accounting_notifications_routed_to_production_alerts.sql.
-- Minimal reproduction of the real Production Alerts inbox writer
-- (fn_record_operational_alert / operational_alert_events) this branch calls.
CREATE TABLE operational_alert_events(id bigserial PRIMARY KEY,source text NOT NULL,event_key text NOT NULL,alertname text,status text,severity text,payload jsonb,last_received_at timestamptz DEFAULT clock_timestamp(),delivery_count int NOT NULL DEFAULT 1,UNIQUE(source,event_key));
CREATE FUNCTION fn_record_operational_alert(p_source text,p_event_key text,p_alertname text,p_status text,p_severity text,p_payload jsonb) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO operational_alert_events(source,event_key,alertname,status,severity,payload)
  VALUES(p_source,p_event_key,p_alertname,p_status,p_severity,p_payload)
  ON CONFLICT (source,event_key) DO UPDATE
  SET last_received_at=clock_timestamp(), delivery_count=operational_alert_events.delivery_count+1
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- (1) FAILING BEFORE / PASSING AFTER: an owner-recipient accounting
-- notification still gets its durable push_outbox receipt (the 20260914141405
-- invariant), but skipped -- never claimable by claim_push_outbox_batch --
-- and coalesced into one Production Alerts info event instead.
SELECT fixture_transfer(u(910),'20000000-0000-0000-0000-000000000001','47965354-0e56-43ef-931c-ddaab82af765','20000000-0000-0000-0000-000000000001');
SELECT assert_true((SELECT count(*)=1 FROM push_outbox p JOIN accounting_invoice_deliveries d ON d.notification_id=p.accounting_notification_id JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=u(910) AND p.status='skipped' AND p.failure_reason='owner_accounting_routed_to_production_alerts'),'owner-recipient accounting notification is a skipped durable receipt, not a device push');
SELECT assert_true((SELECT count(*)=1 FROM operational_alert_events WHERE source='owner-accounting-notifications' AND status='info' AND severity='info'),'owner accounting notification is coalesced into one Production Alerts info event');
SELECT assert_true((SELECT delivery_count FROM operational_alert_events WHERE source='owner-accounting-notifications')=1,'first owner accounting notification of the hour starts delivery_count at one');

-- A second owner-recipient notification in the same hour coalesces onto the
-- same informational event instead of flooding the inbox, and still gets its
-- own durable, skipped outbox receipt (one row per notification, invariant
-- preserved).
SELECT fixture_transfer(u(911),'20000000-0000-0000-0000-000000000001','47965354-0e56-43ef-931c-ddaab82af765','20000000-0000-0000-0000-000000000001');
SELECT assert_true((SELECT count(*)=1 FROM push_outbox p JOIN accounting_invoice_deliveries d ON d.notification_id=p.accounting_notification_id JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=u(911) AND p.status='skipped' AND p.failure_reason='owner_accounting_routed_to_production_alerts'),'second owner accounting notification in the same hour is also its own skipped durable receipt');
SELECT assert_true((SELECT count(*) FROM operational_alert_events WHERE source='owner-accounting-notifications')=1,'still exactly one Production Alerts row for the hour, not one per receipt');
SELECT assert_true((SELECT delivery_count FROM operational_alert_events WHERE source='owner-accounting-notifications')=2,'delivery_count becomes the hour''s receipt count instead of a new row per receipt');

-- A non-owner payee's accounting notification is completely unaffected: it
-- still becomes a pending device push, exactly as before this migration.
SELECT fixture_transfer(u(912),'20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000001');
SELECT assert_true((SELECT count(*)=1 FROM push_outbox p JOIN accounting_invoice_deliveries d ON d.notification_id=p.accounting_notification_id JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=u(912) AND p.status='pending'),'non-owner payee keeps their own accounting push exactly as before');

-- Cashier post-check interaction: the cashier_cashout/accounting_correction/
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

-- A Production Alerts write failure can never roll back the financial
-- document: with fn_record_operational_alert forced to fail, the invoice,
-- Messenger message and durable outbox receipt still all commit.
CREATE OR REPLACE FUNCTION fn_record_operational_alert(p_source text,p_event_key text,p_alertname text,p_status text,p_severity text,p_payload jsonb) RETURNS bigint LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'forced inbox failure'; END$$;
SELECT fixture_transfer(u(914),'20000000-0000-0000-0000-000000000001','47965354-0e56-43ef-931c-ddaab82af765','20000000-0000-0000-0000-000000000001');
SELECT assert_true((SELECT count(*)=1 FROM push_outbox p JOIN accounting_invoice_deliveries d ON d.notification_id=p.accounting_notification_id JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=u(914) AND p.status='skipped' AND p.failure_reason='owner_accounting_routed_to_production_alerts'),'Production Alerts write failure does not stop the durable receipt from being written');
SELECT assert_true(EXISTS(SELECT 1 FROM settlement_invoices i WHERE i.source_ledger_id=u(914)) AND EXISTS(SELECT 1 FROM social_messages sm JOIN accounting_invoice_deliveries d ON d.message_id=sm.id JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=u(914)),'invoice and Messenger message still commit when the Production Alerts write fails');
CREATE OR REPLACE FUNCTION fn_record_operational_alert(p_source text,p_event_key text,p_alertname text,p_status text,p_severity text,p_payload jsonb) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO operational_alert_events(source,event_key,alertname,status,severity,payload)
  VALUES(p_source,p_event_key,p_alertname,p_status,p_severity,p_payload)
  ON CONFLICT (source,event_key) DO UPDATE
  SET last_received_at=clock_timestamp(), delivery_count=operational_alert_events.delivery_count+1
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

SELECT assert_true(NOT EXISTS(SELECT 1 FROM push_outbox WHERE accounting_notification_id IN (
  SELECT d.notification_id FROM accounting_invoice_deliveries d JOIN settlement_invoices i ON i.id=d.invoice_id
  WHERE i.source_ledger_id IN (u(910),u(911),u(914))
) AND status='sent'),'no owner-recipient accounting notification is ever sent as a device push');
