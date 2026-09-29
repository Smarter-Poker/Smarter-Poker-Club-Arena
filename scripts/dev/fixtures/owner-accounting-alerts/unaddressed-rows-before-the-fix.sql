-- Production's shape since 2026-09-29, before 20260928032225 is applied: the
-- #5428 body (the fix's pre-image) has stored rows under
-- 'owner-accounting-notifications' without payload.target_task_id, and the
-- fleet has triaged one of them (operational_alert_events id 176726: the hour
-- 2026-09-29T02 UTC, delivery_count 1, investigation_status 'investigating').
-- The migration as first published refused to install over any such row.
-- scripts/dev/test-accounting-push-bridge.sh runs this in its second cluster,
-- after the pre-image and before the fix; unaddressed-rows-kept-after-the-fix.sql
-- then asserts what the fix did with these rows. Values are synthetic; the
-- shape is production's. Its sha256 is pinned in
-- tests/an-operational-alert-sender-addresses-the-fleet.law.test.ts.

-- Another source's unaddressed row, stored first so that its id is below every
-- owner accounting row: nothing may exempt it by position.
SELECT fn_record_operational_alert('fixture-other-source','fixture-rows-before-the-fix:other','Probe','firing','warning','{}'::jsonb);

-- (1) The pre-image itself stores the hour's owner accounting row, unaddressed.
SELECT fixture_transfer(u(930),'20000000-0000-0000-0000-000000000001','47965354-0e56-43ef-931c-ddaab82af765','20000000-0000-0000-0000-000000000001');
SELECT assert_true((SELECT count(*)=1 FROM operational_alert_events WHERE source='owner-accounting-notifications' AND event_key LIKE 'owner-accounting:%'
  AND NOT payload ? 'target_task_id' AND delivery_count=1),'the pre-image stores the hour''s owner accounting row without the fleet address');

-- (2) An earlier hour's row in the shape of 176726: the pre-image's six keys,
-- recorded through the writer exactly as the pre-image calls it.
SELECT fn_record_operational_alert('owner-accounting-notifications','owner-accounting:2026-09-29T02','Accounting Documents Issued (Owner Copy)','info','info',
  jsonb_build_object('first_notification_id',u(931),'invoice_number','FIXTURE-0931','invoice_type','club_weekly_accounting','amount',0,'conversation_id',u(932),'hour','2026-09-29T02'));
-- The fleet's triage of it: the only columns the fleet writes.
UPDATE operational_alert_events SET investigation_status='investigating',
  investigation=jsonb_build_object('lane','PRIMARY-CHAT','status','investigating','summary','fixture triage','candidate','20260928032225',
    'updated_at','2026-09-29T10:00:00Z','incident_key','owner-accounting-unaddressed')
 WHERE source='owner-accounting-notifications' AND event_key='owner-accounting:2026-09-29T02';

-- The state the first published guard refused.
SELECT assert_true((SELECT count(*)=2 FROM operational_alert_events WHERE source='owner-accounting-notifications'
  AND (payload->>'target_task_id') IS DISTINCT FROM '01a09b86-5ba8-7290-8657-1041f13dd3ca'),'two unaddressed owner accounting rows, one triaged, are stored before the fix');

-- What the fix must keep: each row's tuple, payload bytes and fleet columns.
CREATE TABLE fixture_rows_before_the_fix AS
  SELECT id,event_key,xmin::text AS tuple_xmin,ctid::text AS tuple_ctid,payload::text AS payload_text,
    delivery_count,last_received_at,investigation_status,investigation
  FROM operational_alert_events WHERE source='owner-accounting-notifications';
