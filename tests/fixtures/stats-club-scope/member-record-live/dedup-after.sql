-- Real original publishers and existing source triggers; no production data.
BEGIN;
TRUNCATE signals;
SELECT fn_publish_member_record_user('30000000-0000-0000-0000-000000000003');
SELECT fn_publish_member_record_user('30000000-0000-0000-0000-000000000003');
UPDATE profiles SET alias='Dedup final alias' WHERE id='30000000-0000-0000-0000-000000000003';
UPDATE club_members SET chip_balance=chip_balance+1 WHERE user_id='30000000-0000-0000-0000-000000000003';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM signals WHERE topic LIKE 'member-record:%') OR
    EXISTS(SELECT 1 FROM signals WHERE topic LIKE 'member-record:%' GROUP BY topic HAVING count(*)<>1) THEN
   RAISE EXCEPTION 'Member topic transaction dedup failed';
 END IF;
 IF EXISTS(SELECT 1 FROM signals WHERE event<>'record_changed' OR private IS NOT TRUE) THEN RAISE EXCEPTION 'Private signal contract changed'; END IF;
 IF (SELECT alias FROM profiles WHERE id='30000000-0000-0000-0000-000000000003')<>'Dedup final alias' THEN RAISE EXCEPTION 'Source mutation lost'; END IF;
END $$;
COMMIT;
TRUNCATE signals;
SELECT fn_publish_member_record_user('30000000-0000-0000-0000-000000000003');
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM signals WHERE topic LIKE 'member-record:%') THEN RAISE EXCEPTION 'Prior transaction cache persisted'; END IF; END $$;
-- A rolled-back signal must not consume the topic for a later valid send.
TRUNCATE signals;
BEGIN;
SAVEPOINT aborted_signal;
SELECT fn_publish_member_record_user('30000000-0000-0000-0000-000000000003');
ROLLBACK TO SAVEPOINT aborted_signal;
SELECT fn_publish_member_record_user('30000000-0000-0000-0000-000000000003');
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM signals WHERE topic LIKE 'member-record:%') OR EXISTS(SELECT 1 FROM signals WHERE topic LIKE 'member-record:%' GROUP BY topic HAVING count(*)<>1) THEN RAISE EXCEPTION 'Savepoint rollback poisoned cache'; END IF; END $$;
ROLLBACK;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM signals) THEN RAISE EXCEPTION 'Rolled back signals leaked'; END IF; END $$;
-- Multiple children share one upline topic, while each child keeps its topic.
BEGIN;
INSERT INTO club_members(user_id,club_id,agent_id,status) VALUES
('60000000-0000-0000-0000-000000000002','60000000-0000-0000-0000-000000000001',NULL,'active'),
('60000000-0000-0000-0000-000000000003','60000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002','active'),
('60000000-0000-0000-0000-000000000004','60000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002','active');
COMMIT;
TRUNCATE signals;
BEGIN;
SELECT fn_publish_member_record_user('60000000-0000-0000-0000-000000000003');
SELECT fn_publish_member_record_user('60000000-0000-0000-0000-000000000004');
DO $$ BEGIN
 IF (SELECT count(*) FROM signals WHERE topic LIKE 'member-record:60000000-%')<>3 OR EXISTS(SELECT 1 FROM signals WHERE topic LIKE 'member-record:60000000-%' GROUP BY topic HAVING count(*)<>1) THEN RAISE EXCEPTION 'Shared upline dedup lost/duplicated recipients'; END IF;
END $$;
COMMIT;
-- The direct OLD membership send shares the same cache, preserving removal.
TRUNCATE signals;
BEGIN;
DELETE FROM club_members WHERE club_id='60000000-0000-0000-0000-000000000001' AND user_id='60000000-0000-0000-0000-000000000003';
SELECT fn_publish_member_record_topic('member-record:60000000-0000-0000-0000-000000000001:60000000-0000-0000-0000-000000000003','{}');
DO $$ BEGIN IF (SELECT count(*) FROM signals WHERE topic='member-record:60000000-0000-0000-0000-000000000001:60000000-0000-0000-0000-000000000003')<>1 THEN RAISE EXCEPTION 'Removed membership signal lost/duplicated'; END IF; END $$;
COMMIT;
-- Isolated provider stub only: a refused send cannot consume the memo.
CREATE OR REPLACE FUNCTION realtime.send(payload jsonb,event text,topic text,private boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('test.member_send_fail',true)='true' THEN RAISE EXCEPTION 'fixture_send_refused'; END IF;
 INSERT INTO public.signals VALUES(topic,payload,event,private);
END $$;
TRUNCATE signals;
BEGIN;
SELECT set_config('test.member_send_fail','true',true);
DO $$ BEGIN
 BEGIN
   PERFORM fn_publish_member_record_topic('member-record:70000000-0000-0000-0000-000000000001:70000000-0000-0000-0000-000000000002','{}');
   RAISE EXCEPTION 'Failed send unexpectedly accepted';
 EXCEPTION WHEN OTHERS THEN
   IF SQLERRM<>'fixture_send_refused' THEN RAISE; END IF;
 END;
 IF coalesce(nullif(current_setting('ca.member_record_signaled_topics',true),''),'[]')::jsonb ? 'member-record:70000000-0000-0000-0000-000000000001:70000000-0000-0000-0000-000000000002' THEN RAISE EXCEPTION 'Failed send consumed memo'; END IF;
END $$;
SELECT set_config('test.member_send_fail','false',true);
SELECT fn_publish_member_record_topic('member-record:70000000-0000-0000-0000-000000000001:70000000-0000-0000-0000-000000000002','{}');
SELECT fn_publish_member_record_topic('member-record:70000000-0000-0000-0000-000000000001:70000000-0000-0000-0000-000000000002','{}');
DO $$ BEGIN IF (SELECT count(*) FROM signals)<>1 THEN RAISE EXCEPTION 'Valid retry was lost/duplicated'; END IF; END $$;
COMMIT;
DO $$ BEGIN
 IF has_function_privilege('authenticated','fn_publish_member_record_topic(text,jsonb)','EXECUTE') OR has_function_privilege('service_role','fn_publish_member_record_topic(text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Publisher ACL widened'; END IF;
END $$;
\echo MEMBER_RECORD_SIGNAL_DEDUP PASS: original source regression, exact topic fanout, final source changes, transaction and savepoint rollback, removal and private ACL
