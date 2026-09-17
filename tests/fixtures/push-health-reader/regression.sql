SELECT assert_true(md5(pg_get_functiondef('public.fn_caller_is_engine()'::regprocedure))='d9a70f1d932538025e656bfe2b4d091d','production authorization dependency unchanged');
CREATE TEMP TABLE snapshot AS SELECT fn_push_health_snapshot('00000000-0000-0000-0000-000000000001') d;
SELECT assert_true((d->'dispatch'->>'minutesSince') IS NULL AND (d->'dispatch'->>'lastRunAt') IS NULL,'never-run dispatcher remains unknown') FROM snapshot;
SELECT assert_true(d->'funnel'->>'confirmRate' IS NULL AND d->'funnel'->>'deliveryRate' IS NULL,'no activity is not a perfect delivery rate') FROM snapshot;
SELECT assert_true(d->'byType'='[]'::jsonb AND d->'skipReasons'='[]'::jsonb,'genuinely empty source has exact empty aggregates') FROM snapshot;
SELECT assert_true((d->'funnel'->>'unreachable')::int=0 AND (d->'funnel'->>'addressable')::int=0 AND d->'funnel'->>'addressableDeliveryRate' IS NULL,'empty addressable cohort has no invented rate') FROM snapshot;
INSERT INTO push_outbox(event,status,failure_reason) SELECT 'tournament_reminder_2m','skipped','no_subscription' FROM generate_series(1,6005);
INSERT INTO push_outbox(event,status,failure_reason) VALUES('accounting_invoice','skipped','digested_into:carrier'),('accounting_invoice','skipped','digested_into:other'),('accounting_invoice','failed','provider_error:403'),('accounting_invoice','skipped','type_disabled:accounting_invoice');
INSERT INTO push_outbox(event,status,sent_at) VALUES('accounting_invoice','sent',now());
INSERT INTO push_outbox(event,status,created_at,sent_at) VALUES('old_sent','sent',now()-interval '8 days',now()),('old_pending','pending',now()-interval '8 days',NULL),('old_skipped','skipped',now()-interval '8 days',NULL),('future','sent',now()+interval '1 day',now()+interval '1 day');
INSERT INTO push_outbox(event,status) VALUES('processing','processing');
INSERT INTO push_subscriptions(user_id,is_active,created_at,last_used_at,last_receipt_at) VALUES
 ('00000000-0000-0000-0000-000000000001',true,now()-interval '5 days',now()-interval '1 hour',now()-interval '30 minutes'),
 ('00000000-0000-0000-0000-000000000001',true,now()-interval '5 days',now()-interval '1 hour',NULL),
 ('00000000-0000-0000-0000-000000000003',true,now()-interval '5 days',now()-interval '1 hour',now()+interval '1 day'),
 ('00000000-0000-0000-0000-000000000003',true,now()-interval '1 hour',now()-interval '30 minutes',NULL),
 ('00000000-0000-0000-0000-000000000003',false,now()-interval '5 days',now()-interval '1 hour',now());
INSERT INTO push_dispatch_runs SELECT now()-n*interval '1 minute',now()-n*interval '1 minute',0,0,0,0,'nothing_pending','push-dispatch' FROM generate_series(1,12)n;
TRUNCATE snapshot;INSERT INTO snapshot SELECT fn_push_health_snapshot('00000000-0000-0000-0000-000000000001');
SELECT assert_true((SELECT (v->>'total')::int FROM jsonb_array_elements(d->'byType')v WHERE v->>'event'='tournament_reminder_2m')=6005,'counts exceed both 1000 and 5000 row transport caps') FROM snapshot;
SELECT assert_true((SELECT (v->>'total')::int FROM jsonb_array_elements(d->'byType')v WHERE v->>'event'='accounting_invoice')=5,'invoice traffic beyond first page remains visible') FROM snapshot;
SELECT assert_true(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'byType')v WHERE v->>'event' IN('old_sent','old_pending','old_skipped','future')),'fixed window excludes old and future traffic') FROM snapshot;
SELECT assert_true((d->'outbox'->>'pending')::int=1 AND (d->'outbox'->>'processing')::int=1,'all-age unfinished backlog remains visible') FROM snapshot;
SELECT assert_true((d->'outbox'->>'sentLast24h')::int=2 AND (d->'funnel'->>'sent')::int=1,'sent timestamp total differs from same-cohort funnel') FROM snapshot;
SELECT assert_true((d->'funnel'->>'queued')::int=6011,'queued funnel uses full exact 24 hour cohort') FROM snapshot;
SELECT assert_true((d->'funnel'->>'unreachable')::int=6005 AND (d->'funnel'->>'addressable')::int=6 AND (d->'funnel'->>'addressableDeliveryRate')::int=17 AND (d->'funnel'->>'deliveryRate')::int=0,'addressable rate excludes no-device skips and preserves the legacy raw rate') FROM snapshot;
SELECT assert_true((SELECT v->>'kind' FROM jsonb_array_elements(d->'skipReasons')v WHERE v->>'reason'='no_subscription')='not_enrolled','no-subscription skips are unreachable recipients, not faults') FROM snapshot;
SELECT assert_true((SELECT (v->>'count')::int FROM jsonb_array_elements(d->'skipReasons')v WHERE v->>'reason'='no_subscription')=6005,'suppression reason counts are not sampled') FROM snapshot;
SELECT assert_true((SELECT v->>'kind' FROM jsonb_array_elements(d->'skipReasons')v WHERE v->>'reason'='digested_into')='throttled','digest suppression preserves its expected classification') FROM snapshot;
SELECT assert_true((SELECT v->>'kind' FROM jsonb_array_elements(d->'skipReasons')v WHERE v->>'reason'='type_disabled')='user_choice','user preference remains distinct from provider fault') FROM snapshot;
SELECT assert_true((SELECT v->>'kind' FROM jsonb_array_elements(d->'skipReasons')v WHERE v->>'reason'='provider_error')='fault','provider errors remain faults') FROM snapshot;
SELECT assert_true((d->'subscriptions'->>'active')::int=4 AND (d->'subscriptions'->>'zombies')::int=2,'device grace period and future receipts cannot conceal mature unconfirmed subscriptions') FROM snapshot;
SELECT assert_true((d->'funnel'->>'devicesPushed')::int=4 AND (d->'funnel'->>'devicesConfirmed')::int=1 AND (d->'funnel'->>'confirmRate')::int=25,'only actual current receipts establish device confirmation') FROM snapshot;
SELECT assert_true((SELECT v->>'status' FROM jsonb_array_elements(d->'staff')v WHERE v->>'username'='god')='zombie','staff with only absent or future receipts are not reachable') FROM snapshot;
SELECT assert_true(jsonb_array_length(d->'dispatch'->'recent')=10 AND (d->'dispatch'->>'minutesSince')::int=1,'dispatch history is bounded and newest first') FROM snapshot;
SELECT assert_true(NOT has_function_privilege('anon','fn_push_health_snapshot(uuid)','EXECUTE'),'anonymous execution is revoked');
SELECT set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
DO $$ BEGIN PERFORM fn_push_health_snapshot('00000000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'FAIL: actor impersonation permitted'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: actor impersonation refused'; END $$;
DO $$ BEGIN PERFORM fn_push_health_snapshot('00000000-0000-0000-0000-000000000002'); RAISE EXCEPTION 'FAIL: nonadmin permitted'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: nonadmin refused'; END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
SELECT assert_true((fn_push_health_snapshot('00000000-0000-0000-0000-000000000001')->>'schemaVersion')::int=1,'verified admin can read exact snapshot');
SELECT set_config('request.jwt.claim.role','service_role',false);
DO $$ BEGIN PERFORM fn_push_health_snapshot('00000000-0000-0000-0000-000000000002'); RAISE EXCEPTION 'FAIL: service nonadmin recipient permitted'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: trusted API still requires administrator actor'; END $$;
SELECT assert_true((SELECT count(*) FROM push_outbox)=6015 AND (SELECT count(*) FROM push_subscriptions)=5,'snapshot does not send or mutate subscription or outbox data');

-- Keep the preceding full-count/auth/receipt scenarios intact, then isolate the
-- denominator edges in this disposable fixture transaction.
BEGIN;
TRUNCATE push_outbox;
INSERT INTO push_outbox(event,status,failure_reason) SELECT 'no_device','skipped','no_subscription' FROM generate_series(1,10);
TRUNCATE snapshot; INSERT INTO snapshot SELECT fn_push_health_snapshot('00000000-0000-0000-0000-000000000001');
SELECT assert_true((d->'funnel'->>'queued')::int=10 AND (d->'funnel'->>'unreachable')::int=10 AND (d->'funnel'->>'addressable')::int=0 AND d->'funnel'->>'addressableDeliveryRate' IS NULL AND (d->'funnel'->>'deliveryRate')::int=0,'all unreachable is n/a for addressable delivery, preserving legacy zero') FROM snapshot;
TRUNCATE push_outbox;
INSERT INTO push_outbox(event,status,failure_reason,sent_at) VALUES
 ('one','skipped','no_subscription',NULL),('two','skipped','no_subscription',NULL),
 ('provider','failed','no_subscription',NULL),('qualified','skipped','no_subscription:other',NULL),
 ('sent','sent',NULL,now());
INSERT INTO push_outbox(event,status,failure_reason,created_at) VALUES
 ('old','skipped','no_subscription',now()-interval '25 hours'),
 ('future','skipped','no_subscription',now()+interval '1 hour');
TRUNCATE snapshot; INSERT INTO snapshot SELECT fn_push_health_snapshot('00000000-0000-0000-0000-000000000001');
SELECT assert_true((d->'funnel'->>'queued')::int=5 AND (d->'funnel'->>'unreachable')::int=2 AND (d->'funnel'->>'addressable')::int=3 AND (d->'funnel'->>'sent')::int=1 AND (d->'funnel'->>'addressableDeliveryRate')::int=33 AND (d->'funnel'->>'deliveryRate')::int=20,'same cohort and exact skip reason preserve current addressable semantics') FROM snapshot;
ROLLBACK;
