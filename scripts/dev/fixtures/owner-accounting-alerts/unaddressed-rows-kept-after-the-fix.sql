-- After 20260928032225 is applied over production's shape
-- (unaddressed-rows-before-the-fix.sql): the rows stored before the fix are
-- kept exactly as recorded and stay updatable, and every later unaddressed row
-- under 'owner-accounting-notifications' is refused. FAILING BEFORE (the
-- migration as first published refused to install over these rows, so the
-- harness stops there) / PASSING AFTER the rebuild. Its sha256 is pinned in
-- tests/an-operational-alert-sender-addresses-the-fleet.law.test.ts.

-- (1) The fix installed over them, and its rule names exactly those rows, each
-- by id and payload digest.
SELECT assert_true(EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='operational_alert_events'::regclass
  AND conname='operational_alert_events_owner_accounting_addressed' AND contype='c' AND convalidated AND NOT condeferrable),
  'the fix installs over unaddressed rows stored before it, and its rule is validated');
SELECT assert_true(position((SELECT format('= ANY (%L::text[])',array_agg(b.id::text||':'||md5(b.payload_text) ORDER BY b.id)) FROM fixture_rows_before_the_fix b)
  IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid='operational_alert_events'::regclass AND conname='operational_alert_events_owner_accounting_addressed')))>0,
  'the rule keeps exactly the rows stored before the fix');

-- (2) Installing the fix rewrote and deleted none of them: the same tuple,
-- the same payload bytes, the same fleet columns.
SELECT assert_true((SELECT count(*)=2 FROM fixture_rows_before_the_fix b JOIN operational_alert_events e ON e.id=b.id
  WHERE e.xmin::text=b.tuple_xmin AND e.ctid::text=b.tuple_ctid AND e.payload::text=b.payload_text AND e.delivery_count=b.delivery_count
    AND e.investigation_status=b.investigation_status AND e.investigation=b.investigation),
  'the rows stored before the fix are the same tuples, byte for byte, after it');

-- (3) The fleet can still triage them.
UPDATE operational_alert_events e SET investigation_status='verified_fixed',investigation=e.investigation||'{"fixture":"closed after the fix"}'
  FROM fixture_rows_before_the_fix b WHERE e.id=b.id;
SELECT assert_true((SELECT count(*)=2 FROM fixture_rows_before_the_fix b JOIN operational_alert_events e ON e.id=b.id
  WHERE e.investigation_status='verified_fixed' AND e.investigation->>'fixture'='closed after the fix' AND e.payload::text=b.payload_text),
  'the fleet''s investigation update of a kept row succeeds and leaves its payload as recorded');

-- (4) The writer's ON CONFLICT bump for their event_key still succeeds, called
-- as the fixed sender calls it. On conflict the writer ignores the payload it
-- was given, so the kept row's payload stays as recorded.
SELECT fn_record_operational_alert('owner-accounting-notifications',b.event_key,'Accounting Documents Issued (Owner Copy)','info','info',
  jsonb_build_object('target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca','first_notification_id',u(936),'hour','fixture'))
  FROM fixture_rows_before_the_fix b ORDER BY b.id;
SELECT assert_true((SELECT count(*)=2 FROM fixture_rows_before_the_fix b JOIN operational_alert_events e ON e.id=b.id
  WHERE e.delivery_count=b.delivery_count+1 AND e.last_received_at>b.last_received_at AND e.payload::text=b.payload_text),
  'the writer''s ON CONFLICT bump of a kept row succeeds and leaves its payload as recorded');
-- PostgreSQL judges the row an INSERT proposes against every CHECK before it
-- looks for a conflict, so a call proposing an unaddressed payload is refused
-- even for a kept row's key (the pre-image's own call, if one was still
-- waiting when the fix committed; its handler catches it), and the kept row is
-- left alone.
SELECT assert_true(refuses($$SELECT fn_record_operational_alert('owner-accounting-notifications',b.event_key,'Accounting Documents Issued (Owner Copy)','info','info','{"fixture":1}'::jsonb)
  FROM fixture_rows_before_the_fix b ORDER BY b.id LIMIT 1$$,'23514')
  AND (SELECT count(*)=2 FROM fixture_rows_before_the_fix b JOIN operational_alert_events e ON e.id=b.id WHERE e.delivery_count=b.delivery_count+1),
  'a call proposing an unaddressed payload is refused even for a kept row''s key, and the kept row is untouched');

-- (5) The fixed sender itself: its hourly recording bumps the kept row the
-- pre-image stored for this hour (or, if the clock has moved on to a new hour,
-- stores a new addressed row), and never fails. The push decision is unchanged.
SELECT fixture_transfer(u(933),'20000000-0000-0000-0000-000000000001','47965354-0e56-43ef-931c-ddaab82af765','20000000-0000-0000-0000-000000000001');
SELECT assert_true((SELECT count(*)=1 FROM push_outbox p JOIN accounting_invoice_deliveries d ON d.notification_id=p.accounting_notification_id JOIN settlement_invoices i ON i.id=d.invoice_id
  WHERE i.source_ledger_id=u(933) AND p.status='skipped' AND p.failure_reason='owner_accounting_routed_to_production_alerts'),'after the fix an owner accounting copy is still a skipped durable receipt');
SELECT assert_true(NOT EXISTS(SELECT 1 FROM operational_alert_events WHERE event_key LIKE 'owner-accounting-unstored:%')
  AND (SELECT sum(delivery_count) FROM operational_alert_events WHERE source='owner-accounting-notifications' AND event_key LIKE 'owner-accounting:%')
    =(SELECT sum(delivery_count)+count(*)+1 FROM fixture_rows_before_the_fix),
  'the fixed sender''s recording beside the kept rows is stored, never refused');

-- (6) Every later unaddressed row under the source is refused, whoever writes it.
SELECT assert_true(refuses($$SELECT fn_record_operational_alert('owner-accounting-notifications','owner-accounting:2099-01-01T00','Accounting Documents Issued (Owner Copy)','info','info',
  jsonb_build_object('first_notification_id',u(934),'invoice_number','FIXTURE-0934','invoice_type','club_weekly_accounting','amount',0,'conversation_id',u(935),'hour','2099-01-01T00'))$$,'23514'),
  'a later hour''s row in the pre-image''s shape is refused');
SELECT assert_true(refuses($$SELECT fn_record_operational_alerts('[{"source":"owner-accounting-notifications","event_key":"fixture-kept:batch","alertname":"Probe","status":"info","severity":"info","payload":{}}]'::jsonb)$$,'23514'),
  'the batch writer cannot store one either');
SELECT assert_true(refuses($$INSERT INTO operational_alert_events(source,event_key,alertname,status,severity,payload) VALUES('owner-accounting-notifications','fixture-kept:direct','Probe','info','info','{"k":1}')$$,'23514'),
  'nor can a direct INSERT');
SELECT assert_true(refuses($$INSERT INTO operational_alert_events(id,source,event_key,alertname,status,severity,payload) OVERRIDING SYSTEM VALUE
  VALUES(0,'owner-accounting-notifications','fixture-kept:low-id','Probe','info','info','{"k":1}')$$,'23514'),
  'nor a row given an id below the kept ones: the rule keeps rows, not a range of ids');
SELECT assert_true(refuses($$UPDATE operational_alert_events SET source='owner-accounting-notifications' WHERE source='fixture-other-source'$$,'23514'),
  'nor another source''s older unaddressed row moved under this source');
SELECT assert_true(refuses($$INSERT INTO operational_alert_events(source,event_key,alertname,status,severity,payload)
  SELECT 'owner-accounting-notifications','fixture-kept:copy','Probe','info','info',e.payload FROM operational_alert_events e
  WHERE e.id=(SELECT min(b.id) FROM fixture_rows_before_the_fix b)$$,'23514'),
  'nor a copy of a kept row''s payload under a new id');
SELECT assert_true(refuses($$UPDATE operational_alert_events e SET payload=e.payload||'{"fixture":"rewritten"}' FROM fixture_rows_before_the_fix b WHERE e.id=b.id$$,'23514'),
  'nor a kept row whose payload is rewritten: it stays as recorded');

-- (7) An addressed row under the source is stored, and other sources write as before.
SELECT assert_true(fn_record_operational_alert('owner-accounting-notifications','fixture-kept:addressed','Probe','info','info',
  jsonb_build_object('target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca')) IS NOT NULL,'an addressed row under the source is stored');
SELECT fn_record_operational_alert('fixture-other-source','fixture-rows-before-the-fix:other','Probe','firing','warning','{}'::jsonb);
SELECT assert_true((SELECT delivery_count=2 FROM operational_alert_events WHERE source='fixture-other-source'),'another source''s unaddressed row is still coalesced');

-- Whatever the hour or the writer, the only unaddressed rows under the source
-- are the ones stored before the fix, with the payloads they were stored with.
SELECT assert_true(NOT EXISTS(SELECT 1 FROM operational_alert_events e WHERE e.source='owner-accounting-notifications'
  AND (e.payload->>'target_task_id') IS DISTINCT FROM '01a09b86-5ba8-7290-8657-1041f13dd3ca'
  AND NOT EXISTS(SELECT 1 FROM fixture_rows_before_the_fix b WHERE b.id=e.id AND b.payload_text=e.payload::text)),
  'no owner accounting row is unaddressed except the ones stored before the fix, as recorded');
