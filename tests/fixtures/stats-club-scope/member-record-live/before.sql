INSERT INTO clubs VALUES('00000000-0000-0000-0000-000000000001','Shark');
INSERT INTO club_members(user_id,club_id,role,status,joined_at,chip_balance,promo_balance) VALUES('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','player','active',now(),0,0);
INSERT INTO profiles(id,alias,status) VALUES('00000000-0000-0000-0000-000000000002','Shark Player','active');
INSERT INTO cash_participant_funding_receipts VALUES('00000000-0000-0000-0000-000000000005','buyin','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001',now()-interval '1 hour',now()-interval '1 hour');
INSERT INTO ca_hand_facts(hand_id,user_id,club_id,table_id,played_at,game_variant,net,rake_paid,vpip,pfr) SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',now(),'nlh',-10,1,true,false FROM generate_series(10,21) n;
DO $$ DECLARE d jsonb; BEGIN
 d:=ca_club_member_detail('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',NULL,NULL);
 IF d#>>'{stats,hands}'<>'0' OR d#>>'{stats,total_fee}'<>'16.55' THEN RAISE EXCEPTION 'Baseline mismatch %',d; END IF;
 RAISE NOTICE 'REPRODUCED: fee=16.55, hands=0 despite 12 funded facts';
END $$;
