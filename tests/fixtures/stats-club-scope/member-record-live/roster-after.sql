DO $$ DECLARE r record; BEGIN
 SELECT * INTO r FROM ca_club_roster_rows('30000000-0000-0000-0000-000000000001') WHERE user_id='30000000-0000-0000-0000-000000000003';
 IF r.total_hands<>12 OR r.total_fees<>16.55 OR r.player_wallet<>100 OR r.promo_wallet<>5 THEN RAISE EXCEPTION 'Roster values wrong %',r; END IF;
 IF (ca_club_member_detail('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000003',NULL,NULL)#>>'{identity,last_login}')::timestamptz IS DISTINCT FROM r.last_login THEN RAISE EXCEPTION 'Detail and roster last-active differ'; END IF;
 IF (SELECT total_hands FROM ca_club_roster_rows('40000000-0000-0000-0000-000000000001') WHERE user_id='30000000-0000-0000-0000-000000000003')<>0 THEN RAISE EXCEPTION 'Physical club received funded hands'; END IF;
 PERFORM set_config('test.viewer','30000000-0000-0000-0000-000000000003',true);
 SELECT * INTO r FROM ca_club_roster_rows('30000000-0000-0000-0000-000000000001') WHERE user_id='30000000-0000-0000-0000-000000000003';
 IF r.can_view_financials OR r.total_hands IS NOT NULL OR r.total_fees IS NOT NULL OR r.player_wallet IS NOT NULL THEN RAISE EXCEPTION 'Identity viewer finance leak'; END IF;
END $$;
-- Exactly one private empty event per club/source transaction, including union
-- scope parents, independent source changes, and original member signals.
TRUNCATE signals;
BEGIN;
UPDATE profiles SET alias='First changed' WHERE id='30000000-0000-0000-0000-000000000003';
UPDATE profiles SET username='second_changed' WHERE id='30000000-0000-0000-0000-000000000003';
UPDATE club_members SET last_active_at=clock_timestamp() WHERE user_id='30000000-0000-0000-0000-000000000003';
UPDATE ca_hand_facts SET net=net-1 WHERE user_id='30000000-0000-0000-0000-000000000003';
UPDATE ca_club_rake_daily_user SET rake_cents=rake_cents+1 WHERE user_id='30000000-0000-0000-0000-000000000003';
DO $$ BEGIN
 IF (SELECT count(*) FROM signals WHERE topic LIKE 'club-roster:%')<>3 THEN RAISE EXCEPTION 'Transaction dedup/union fanout wrong'; END IF;
 IF EXISTS(SELECT 1 FROM signals WHERE topic LIKE 'club-roster:%' AND (payload<>'{}'::jsonb OR event<>'record_changed' OR private IS NOT TRUE)) THEN RAISE EXCEPTION 'Roster signal privacy wrong'; END IF;
 IF NOT EXISTS(SELECT 1 FROM signals WHERE topic LIKE 'member-record:%') THEN RAISE EXCEPTION 'Member signals regressed'; END IF;
END $$;
COMMIT;
-- Dedup is transaction-local and rolls back with the write.
TRUNCATE signals;
BEGIN; UPDATE profiles SET alias='Rolled back' WHERE id='30000000-0000-0000-0000-000000000003'; ROLLBACK;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM signals) THEN RAISE EXCEPTION 'Rolled-back signal leaked'; END IF; END $$;
UPDATE profiles SET alias='Committed' WHERE id='30000000-0000-0000-0000-000000000003';
DO $$ BEGIN IF (SELECT count(*) FROM signals WHERE topic LIKE 'club-roster:%')<>3 THEN RAISE EXCEPTION 'Prior transaction dedup persisted'; END IF; END $$;
TRUNCATE signals;
INSERT INTO agents(user_id,club_id,status,agent_wallet_balance,promo_wallet_balance) VALUES('30000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001','active',20,3);
DO $$ BEGIN IF (SELECT count(*) FROM signals WHERE topic LIKE 'club-roster:%')<>3 THEN RAISE EXCEPTION 'Agent insert not relayed'; END IF; END $$;
TRUNCATE signals;
UPDATE agents SET status='inactive' WHERE user_id='30000000-0000-0000-0000-000000000003';
DO $$ BEGIN IF (SELECT count(*) FROM signals WHERE topic LIKE 'club-roster:%')<>3 THEN RAISE EXCEPTION 'Agent status not relayed'; END IF; END $$;
TRUNCATE signals;
DELETE FROM agents WHERE user_id='30000000-0000-0000-0000-000000000003';
DO $$ BEGIN IF (SELECT count(*) FROM signals WHERE topic LIKE 'club-roster:%')<>3 THEN RAISE EXCEPTION 'Agent removal not relayed'; END IF; END $$;
TRUNCATE signals;
INSERT INTO chip_transactions(from_user_id,to_user_id,club_id,amount) VALUES('30000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001',1);
DO $$ BEGIN IF (SELECT count(*) FROM signals WHERE topic LIKE 'club-roster:%')<>3 THEN RAISE EXCEPTION 'Transaction insert not relayed'; END IF; END $$;
TRUNCATE signals;
DELETE FROM chip_transactions WHERE to_user_id='30000000-0000-0000-0000-000000000003';
DO $$ BEGIN IF (SELECT count(*) FROM signals WHERE topic LIKE 'club-roster:%')<>3 THEN RAISE EXCEPTION 'Transaction removal not relayed'; END IF; END $$;
TRUNCATE signals;
DELETE FROM ca_club_rake_daily_user WHERE user_id='30000000-0000-0000-0000-000000000003';
DO $$ BEGIN IF (SELECT count(*) FROM signals WHERE topic LIKE 'club-roster:%')<>3 THEN RAISE EXCEPTION 'Fee removal not relayed'; END IF; END $$;
-- Removing the final club membership still notifies its former roster.
TRUNCATE signals;
DELETE FROM club_members WHERE user_id='30000000-0000-0000-0000-000000000003' AND club_id='40000000-0000-0000-0000-000000000001';
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM signals WHERE topic='club-roster:40000000-0000-0000-0000-000000000001') THEN RAISE EXCEPTION 'Deleted membership roster missing'; END IF; END $$;
-- Provider authorization probe carries topic/extension, without private=true.
TRUNCATE realtime.messages;
INSERT INTO realtime.messages(extension,topic) VALUES('broadcast','club-roster:30000000-0000-0000-0000-000000000001'),('broadcast','club-roster:40000000-0000-0000-0000-000000000001');
GRANT SELECT ON realtime.messages TO authenticated;
SELECT set_config('test.viewer','30000000-0000-0000-0000-000000000003',false),set_config('realtime.topic','club-roster:30000000-0000-0000-0000-000000000001',false);
SET ROLE authenticated;
DO $$ BEGIN IF (SELECT count(*) FROM realtime.messages)<>1 THEN RAISE EXCEPTION 'Authorized provider probe refused/cross-topic leak'; END IF; END $$;
RESET ROLE;
SELECT set_config('test.viewer','30000000-0000-0000-0000-000000000009',false);
SET ROLE authenticated;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM realtime.messages) THEN RAISE EXCEPTION 'Outsider subscribed'; END IF; END $$;
RESET ROLE;
UPDATE profiles SET is_admin=true WHERE id='30000000-0000-0000-0000-000000000009';
SET ROLE authenticated;
DO $$ BEGIN IF (SELECT count(*) FROM realtime.messages)<>1 THEN RAISE EXCEPTION 'Platform admission differs'; END IF; END $$;
RESET ROLE;
UPDATE profiles SET is_admin=false WHERE id='30000000-0000-0000-0000-000000000009';
INSERT INTO fixture_union_staff VALUES('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000009');
SET ROLE authenticated;
DO $$ BEGIN IF (SELECT count(*) FROM realtime.messages)<>1 THEN RAISE EXCEPTION 'Union overseer admission differs'; END IF; END $$;
RESET ROLE;
DELETE FROM fixture_union_staff;
UPDATE club_members SET status='suspended' WHERE user_id='30000000-0000-0000-0000-000000000003';
SELECT set_config('test.viewer','30000000-0000-0000-0000-000000000003',false);
DO $$ BEGIN
 IF ca_club_roster_can_subscribe('club-roster:30000000-0000-0000-0000-000000000001') THEN RAISE EXCEPTION 'Suspended viewer subscribed'; END IF;
 IF ca_club_roster_can_subscribe('club-roster:invalid') THEN RAISE EXCEPTION 'Malformed topic subscribed'; END IF;
 IF has_function_privilege('authenticated','fn_publish_club_roster(uuid)','EXECUTE') OR has_function_privilege('anon','ca_club_roster_can_subscribe(text)','EXECUTE') THEN RAISE EXCEPTION 'Publisher/helper ACL leak'; END IF;
END $$;
SELECT set_config('test.viewer','30000000-0000-0000-0000-000000000002',false);
UPDATE club_members SET status='active' WHERE user_id='30000000-0000-0000-0000-000000000003';
SELECT set_config('test.cutoff',(now()+interval '1 hour')::text,false);
DO $$ BEGIN IF (SELECT total_hands FROM ca_club_roster_rows('30000000-0000-0000-0000-000000000001') WHERE user_id='30000000-0000-0000-0000-000000000003')<>0 THEN RAISE EXCEPTION 'Cutoff generation leaked'; END IF; END $$;
SELECT set_config('test.cutoff','',false);
\echo MEMBER_ROSTER_CONSISTENCY PASS: funded counts, last-active parity, unchanged fee/wallet/redaction, private source events, union fanout, transaction dedup, rollback and admission
