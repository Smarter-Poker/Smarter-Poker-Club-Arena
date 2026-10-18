DO $$ DECLARE d jsonb; n bigint; BEGIN
 d:=ca_club_member_detail('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',NULL,NULL);
 IF d#>>'{stats,hands}'<>'12' OR (d#>>'{stats,total_winnings}')::numeric<>-120 THEN RAISE EXCEPTION 'Overall wrong %',d; END IF;
 d:=ca_club_member_detail('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',current_date,current_date);
 IF d#>>'{stats,hands}'<>'12' THEN RAISE EXCEPTION 'Range wrong %',d; END IF;
 d:=ca_club_member_statistics('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','nlh',current_date,current_date);
 IF d->>'hands'<>'12' THEN RAISE EXCEPTION 'Statistics wrong %',d; END IF;
 d:=ca_club_member_win_loss('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002');
 IF (d#>>'{today,cash}')::numeric<>-120 OR (d#>>'{overall,cash}')::numeric<>-120 THEN RAISE EXCEPTION 'Winloss wrong %',d; END IF;
 SELECT count(*) INTO n FROM ca_club_members_win_loss('00000000-0000-0000-0000-000000000001',ARRAY['00000000-0000-0000-0000-000000000002'::uuid],'overall') WHERE cash=-120;
 IF n<>1 THEN RAISE EXCEPTION 'List mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM ca_member_record_daily_facts('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002',NULL,NULL)) THEN RAISE EXCEPTION 'Wrong club leaked'; END IF;
 IF EXISTS(SELECT 1 FROM ca_member_record_daily_facts('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',current_date-2,current_date-1)) THEN RAISE EXCEPTION 'Date boundary leaked'; END IF;
 PERFORM set_config('test.access','none',false);
 IF ca_club_member_win_loss('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002') IS NOT NULL THEN RAISE EXCEPTION 'Permission leak'; END IF;
 PERFORM set_config('test.access','staff',false);
END $$;
TRUNCATE signals;
UPDATE profiles SET alias='Updated' WHERE id='00000000-0000-0000-0000-000000000002';
UPDATE ca_hand_facts SET net=-11 WHERE hand_id='00000000-0000-0000-0000-000000000010';
DO $$ BEGIN
 IF (SELECT count(*) FROM signals)<>2 THEN RAISE EXCEPTION 'Missing profile/fact live signals'; END IF;
 IF EXISTS(SELECT 1 FROM signals WHERE payload ? 'net' OR payload ? 'alias') THEN RAISE EXCEPTION 'Sensitive payload'; END IF;
 IF has_function_privilege('authenticated','ca_member_record_daily_facts(uuid,uuid,date,date)','EXECUTE') THEN RAISE EXCEPTION 'Helper public'; END IF;
END $$;

INSERT INTO table_seats VALUES('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001',NULL,now());
INSERT INTO ca_club_rake_daily_user VALUES('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001');
INSERT INTO chip_transactions(from_user_id,to_user_id,club_id,amount) VALUES('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000001',5);
DELETE FROM club_members WHERE user_id='00000000-0000-0000-0000-000000000002';
DO $$ BEGIN IF (SELECT count(*) FROM signals)<6 THEN RAISE EXCEPTION 'Source invalidation missing'; END IF; END $$;

SELECT set_config('test.viewer','00000000-0000-0000-0000-000000000009',false);
DO $$ BEGIN
 PERFORM set_config('test.access','none',false);
 IF ca_member_record_can_subscribe('member-record:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002') THEN RAISE EXCEPTION 'Private join leak'; END IF;
 PERFORM set_config('test.access','identity',false);
 IF NOT ca_member_record_can_subscribe('member-record:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002') THEN RAISE EXCEPTION 'Identity join missing'; END IF;
 IF ca_member_record_can_subscribe('member-record:invalid:invalid') THEN RAISE EXCEPTION 'Invalid join accepted'; END IF;
END $$;

-- A captured card-only/no-op update must not repaint every mounted record.
TRUNCATE signals;
UPDATE ca_hand_facts SET net=net;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM signals) THEN RAISE EXCEPTION 'Unchanged facts emitted signals'; END IF; END $$;

SELECT set_config('test.cutoff',(now()+interval '1 hour')::text,false);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM ca_member_record_daily_facts('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',NULL,NULL)) THEN RAISE EXCEPTION 'Pre-reset generation leaked'; END IF;
END $$;
INSERT INTO ca_hand_facts(hand_id,user_id,club_id,table_id,played_at,game_variant,net,rake_paid)
VALUES('00000000-0000-0000-0000-000000000040','00000000-0000-0000-0000-000000000002',
'00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',now()+interval '2 hours','nlh',5,1);
DO $$ BEGIN
 IF (SELECT sum(hands) FROM ca_member_record_daily_facts('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',NULL,NULL))<>1 THEN RAISE EXCEPTION 'New reset generation missing'; END IF;
END $$;
