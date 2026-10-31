DO $$ BEGIN
 IF ca_club_member_jackpot_money('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002',NULL,NULL,'plo5')<>25 THEN RAISE EXCEPTION 'Departed credit not recovered'; END IF;
 IF ca_club_member_jackpot_money('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002',NULL,NULL)<>0 THEN RAISE EXCEPTION 'Seed or other club leaked'; END IF;
END $$;
TRUNCATE signals;
-- Three distinct recipients represent loser, winner and table shares. Every kind,
-- receiving club and seat/wallet route uses the same actual credit function.
DO $$
DECLARE u uuid; c uuid; p uuid; k text; i int; amount numeric;
BEGIN
 FOREACH k IN ARRAY ARRAY['main','mini'] LOOP
  p:=gen_random_uuid();
  INSERT INTO bbj_payouts(id,pool_id,table_id,kind,metadata)
   VALUES(p,'40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',k,'{"variant":"plo5"}');
  FOR i IN 1..3 LOOP
   u:=gen_random_uuid();c:=gen_random_uuid();amount:=CASE i WHEN 1 THEN 50 WHEN 2 THEN 25 ELSE 12.5 END;
   INSERT INTO club_members(user_id,club_id,chip_balance,status) VALUES(u,c,100,'active');
   INSERT INTO table_seats(user_id,table_id,club_id,stack,joined_at,left_at)
    VALUES(u,'30000000-0000-0000-0000-000000000001',c,100,now(),CASE WHEN i=3 THEN now() END);
   IF NOT bbj_credit_one_recipient(p,'30000000-0000-0000-0000-000000000001',u,amount,i<>3) THEN RAISE EXCEPTION 'Credit failed'; END IF;
   IF bbj_credit_one_recipient(p,'30000000-0000-0000-0000-000000000001',u,amount,i<>3) THEN RAISE EXCEPTION 'Duplicate accepted'; END IF;
   IF ca_club_member_jackpot_money(c,u,NULL,NULL,'plo5')<>amount THEN RAISE EXCEPTION 'Recipient kind/route missing % %',k,i; END IF;
   -- Reporting survives all mutable hand/seat/club evidence disappearing.
   DELETE FROM table_seats WHERE user_id=u;
   UPDATE club_members SET club_id=gen_random_uuid() WHERE user_id=u;
   IF ca_club_member_jackpot_money(c,u,NULL,NULL,'plo5')<>amount THEN RAISE EXCEPTION 'Award followed later membership'; END IF;
  END LOOP;
 END LOOP;
 IF (SELECT count(*) FROM signals)<>6 THEN RAISE EXCEPTION 'Every paid recipient must signal exactly once'; END IF;
END $$;
-- Exception rollback cannot leave reporting provenance or signals for an unpaid credit.
DO $$ DECLARE p uuid:=gen_random_uuid(); u uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); BEGIN
 INSERT INTO bbj_payouts(id,pool_id,table_id,kind) VALUES(p,'40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','main');
 INSERT INTO club_members(user_id,club_id,chip_balance,status) VALUES(u,c,100,'active');
 INSERT INTO table_seats(user_id,table_id,club_id,stack,joined_at) VALUES(u,'30000000-0000-0000-0000-000000000001',c,100,now());
 BEGIN
  PERFORM bbj_credit_one_recipient(p,'30000000-0000-0000-0000-000000000001',u,5,true);
  RAISE EXCEPTION 'rollback fixture';
 EXCEPTION WHEN raise_exception THEN NULL; END;
 IF EXISTS(SELECT FROM bbj_recipient_reporting_owners WHERE payout_id=p) OR EXISTS(SELECT FROM bbj_payout_recipients WHERE payout_id=p)
 OR (SELECT stack FROM table_seats WHERE user_id=u)<>100 OR (SELECT count(*) FROM signals)<>6 THEN RAISE EXCEPTION 'Rollback escaped reporting or money'; END IF;
 IF has_table_privilege('authenticated','bbj_recipient_reporting_owners','SELECT') OR has_table_privilege('authenticated','ca_paid_jackpot_reporting','SELECT') THEN RAISE EXCEPTION 'Private reporting exposed'; END IF;
END $$;
