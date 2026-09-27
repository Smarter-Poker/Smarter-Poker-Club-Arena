-- Push delivery is for reachable recipients, never decided by species.
-- Added alongside 20260927221309_push_delivery_is_for_reachable_recipients.sql.
-- CLAUDE.md 10.5: the outcome must be IDENTICAL for a horse and a human in
-- the same device state, so every case runs as both.
CREATE FUNCTION fixture_set_reach(p_user uuid,p_horse boolean,p_device text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE profiles SET is_horse=p_horse WHERE id=p_user;
 DELETE FROM push_subscriptions WHERE user_id=p_user;
 IF p_device='active' THEN INSERT INTO push_subscriptions(user_id,endpoint,is_active) VALUES(p_user,'https://push.example/'||p_user,true);
 ELSIF p_device='retired' THEN INSERT INTO push_subscriptions(user_id,endpoint,is_active) VALUES(p_user,'https://push.example/'||p_user,false);
 END IF;
END $$;
CREATE FUNCTION fixture_receipt(p_ledger uuid) RETURNS push_outbox LANGUAGE sql AS $$
 SELECT p.* FROM push_outbox p JOIN accounting_invoice_deliveries d ON d.notification_id=p.accounting_notification_id
 JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=p_ledger $$;

-- The historical fixture pins invoice numbers up to CA-2026-00000081, and the
-- live counter would walk into them; start this file's invoices past them.
UPDATE accounting_invoice_counters SET next_number=GREATEST(next_number,
 (SELECT max(split_part(invoice_number,'-',3)::bigint)+1 FROM settlement_invoices WHERE invoice_number LIKE 'CA-%'));

-- (1) ACCOUNTING, NO DEVICE: the durable receipt still exists (the
-- 20260914141405 invariant) but is born skipped with the dispatcher's own
-- reason, identically for a horse and a human.
SELECT fixture_set_reach('10000000-0000-0000-0000-000000000004',true,'none');
SELECT fixture_transfer(u(920),'20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000001');
SELECT assert_true((SELECT count(*)=1 FROM push_outbox p JOIN accounting_invoice_deliveries d ON d.notification_id=p.accounting_notification_id JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.source_ledger_id=u(920)),'horse with no device still gets exactly one durable accounting receipt');
SELECT assert_true((fixture_receipt(u(920))).status='skipped' AND (fixture_receipt(u(920))).failure_reason='no_subscription','horse with no device: accounting receipt is skipped no_subscription, never claimable');
SELECT fixture_set_reach('10000000-0000-0000-0000-000000000004',false,'none');
SELECT fixture_transfer(u(921),'20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000001');
SELECT assert_true((fixture_receipt(u(921))).status='skipped' AND (fixture_receipt(u(921))).failure_reason='no_subscription','human with no device: the identical skipped no_subscription receipt');

-- (2) ACCOUNTING, RETIRED DEVICE ONLY: an inactive subscription is not a device.
SELECT fixture_set_reach('10000000-0000-0000-0000-000000000004',false,'retired');
SELECT fixture_transfer(u(922),'20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000001');
SELECT assert_true((fixture_receipt(u(922))).status='skipped' AND (fixture_receipt(u(922))).failure_reason='no_subscription','a retired subscription does not make a recipient reachable');

-- (3) ACCOUNTING, ACTIVE DEVICE: pending exactly as before, horse or human.
SELECT fixture_set_reach('10000000-0000-0000-0000-000000000004',true,'active');
SELECT fixture_transfer(u(923),'20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000001');
SELECT assert_true((fixture_receipt(u(923))).status='pending' AND (fixture_receipt(u(923))).failure_reason IS NULL,'horse WITH a device keeps its pending accounting push (never excluded by species)');
SELECT fixture_set_reach('10000000-0000-0000-0000-000000000004',false,'active');
SELECT fixture_transfer(u(924),'20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000001');
SELECT assert_true((fixture_receipt(u(924))).status='pending' AND (fixture_receipt(u(924))).failure_reason IS NULL,'human WITH a device keeps its pending accounting push');

-- (4) The owner gate from 20260927143752 is evaluated first and is untouched:
-- with no device the owner copy still reads owner-routed, not no_subscription,
-- and still coalesces into the hour's Production Alerts info event.
CREATE TEMP TABLE owner_alert_before AS SELECT COALESCE(sum(delivery_count),0) n FROM operational_alert_events WHERE source='owner-accounting-notifications';
SELECT fixture_transfer(u(925),'20000000-0000-0000-0000-000000000001','47965354-0e56-43ef-931c-ddaab82af765','20000000-0000-0000-0000-000000000001');
SELECT assert_true((fixture_receipt(u(925))).status='skipped' AND (fixture_receipt(u(925))).failure_reason='owner_accounting_routed_to_production_alerts','owner accounting copy is still owner-routed ahead of the reachability check');
SELECT assert_true((SELECT COALESCE(sum(delivery_count),0) FROM operational_alert_events WHERE source='owner-accounting-notifications')=(SELECT n+1 FROM owner_alert_before),'owner copy still coalesces into the Production Alerts hour');

-- (5) Each accounting transfer in this file owns exactly one durable receipt
-- (20260914141405), whatever the device state.
SELECT assert_true((SELECT count(*)=6 FROM settlement_invoices i JOIN accounting_invoice_deliveries d ON d.invoice_id=i.id
  WHERE i.source_ledger_id IN(u(920),u(921),u(922),u(923),u(924),u(925))
  AND (SELECT count(*) FROM push_outbox p WHERE p.accounting_notification_id=d.notification_id)=1),'every accounting transfer here has exactly one durable receipt');

-- (6) NON-ACCOUNTING: no row is written for a recipient with no active
-- device; a recipient with one is queued as before. Horse and human alike.
SELECT fixture_set_reach('10000000-0000-0000-0000-000000000003',true,'none');
SELECT fixture_set_reach('10000000-0000-0000-0000-000000000005',false,'none');
SELECT fixture_set_reach('10000000-0000-0000-0000-000000000006',true,'active');
SELECT fixture_set_reach('10000000-0000-0000-0000-000000000001',false,'active');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM push_outbox WHERE recipient_user_id IN('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001') AND status IN('pending','processing') AND accounting_notification_id IS NULL),'precondition: none of the non-accounting recipients is at the queue cap');
INSERT INTO notifications(user_id,type,title,message) VALUES
 ('10000000-0000-0000-0000-000000000003','bonus','Reach Horse None','Daily bonus'),
 ('10000000-0000-0000-0000-000000000005','bonus','Reach Human None','Daily bonus'),
 ('10000000-0000-0000-0000-000000000006','bonus','Reach Horse Device','Daily bonus'),
 ('10000000-0000-0000-0000-000000000001','bonus','Reach Human Device','Daily bonus');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM push_outbox WHERE title='Reach Horse None'),'horse with no device: no push row is written');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM push_outbox WHERE title='Reach Human None'),'human with no device: no push row is written either');
SELECT assert_true((SELECT count(*)=1 FROM push_outbox WHERE title='Reach Horse Device' AND status='pending'),'horse WITH a device is queued like anyone');
SELECT assert_true((SELECT count(*)=1 FROM push_outbox WHERE title='Reach Human Device' AND status='pending'),'human WITH a device is queued');

-- (7) The body never reads is_horse: the predicate is the device, nothing else.
SELECT assert_true(position('is_horse' IN pg_get_functiondef('public.fn_mirror_notification_to_push_outbox()'::regprocedure))=0,'the mirror never decides by species');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM push_outbox WHERE status='sent'),'native verification never sends a device push');
