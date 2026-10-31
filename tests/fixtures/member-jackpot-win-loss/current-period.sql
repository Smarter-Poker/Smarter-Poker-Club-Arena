-- The same player has an unresolved OLD receipt and a valid current paid share.
CREATE TABLE current_period_expected AS SELECT ca_club_member_win_loss(
 '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001') card;
INSERT INTO bbj_payouts(id,table_id,kind,metadata) VALUES
 ('a0000000-0000-0000-0000-000000000001',gen_random_uuid(),'main','{"variant":"nlh"}');
INSERT INTO bbj_payout_recipients VALUES
 ('a0000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',123,'2026-07-25 12:00Z');
DO $$ BEGIN
 BEGIN
  PERFORM ca_club_member_win_loss('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001');
  RAISE EXCEPTION 'Old client must not receive partial numbers';
 EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
END $$;
SET request.headers='{"x-client-info":"club-arena-member-results/2"}';
DO $$ DECLARE d jsonb; expected jsonb; BEGIN
 d:=ca_club_member_win_loss('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001');
 SELECT card INTO expected FROM current_period_expected;
 IF d->'today' IS DISTINCT FROM expected->'today' OR d->'week' IS DISTINCT FROM expected->'week'
 OR d->'month' IS DISTINCT FROM expected->'month' THEN RAISE EXCEPTION 'Historical receipt hid current results'; END IF;
 IF d->'overall'->'net' IS DISTINCT FROM 'null'::jsonb OR d->'overall'->'cash' IS DISTINCT FROM 'null'::jsonb
 OR d->'overall'->'mtt' IS DISTINCT FROM expected->'overall'->'mtt' THEN RAISE EXCEPTION 'Unknown total fabricated or tournament amount hidden'; END IF;
 IF (SELECT net FROM ca_club_members_win_loss('10000000-0000-0000-0000-000000000001',ARRAY['20000000-0000-0000-0000-000000000001'::uuid],'overall')) IS NOT NULL
 THEN RAISE EXCEPTION 'Roster unknown total fabricated'; END IF;
 d:=ca_club_member_detail('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',NULL,NULL);
 IF d->'stats'->'total_winnings' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Detail unknown winnings fabricated'; END IF;
 IF (SELECT count(*) FROM bbj_payout_recipients WHERE payout_id='a0000000-0000-0000-0000-000000000001' AND amount=123)<>1
 OR EXISTS(SELECT FROM bbj_recipient_reporting_owners WHERE payout_id='a0000000-0000-0000-0000-000000000001') THEN RAISE EXCEPTION 'Historical receipt changed'; END IF;
END $$;
RESET request.headers;
