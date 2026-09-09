-- Disposable database behavior assertions; no production connection.
DO $test$
DECLARE
 v_user uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 v_table uuid := 'dddddddd-dddd-dddd-dddd-dddddddddddd';
 v_club uuid := 'cccccccc-cccc-cccc-cccc-cccccccccccc';
 v_category text;
 v_balance numeric;
BEGIN
 INSERT INTO tables(id,current_players) VALUES(v_table,1);
 INSERT INTO club_members(user_id,club_id,chip_balance) VALUES(v_user,v_club,100);
 INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,joined_at,club_id)
 VALUES(gen_random_uuid(),v_table,v_user,2,25,now(),v_club);
 FOREACH v_category IN ARRAY ARRAY['cashout','rakeback','tournament_prize','refund'] LOOP
  PERFORM atomic_credit_wallet_and_log(v_user,25,v_category,'valid destination',v_table,NULL,NULL,'valid:'||v_category);
 END LOOP;
 SELECT chip_balance INTO v_balance FROM club_members WHERE user_id=v_user AND club_id=v_club;
 IF v_balance IS DISTINCT FROM 200::numeric
    OR (SELECT count(*) FROM chip_transactions) <> 4
    OR (SELECT count(*) FROM wallet_credit_idempotency) <> 4 THEN
  RAISE EXCEPTION 'Valid credit totals do not conserve 100 + four credits of 25';
 END IF;
 PERFORM atomic_credit_wallet_and_log(v_user,25,'cashout','replay',v_table,NULL,NULL,'valid:cashout');
 IF (SELECT chip_balance FROM club_members) IS DISTINCT FROM 200::numeric
    OR (SELECT count(*) FROM wallet_transactions) <> 1 THEN
  RAISE EXCEPTION 'Committed retry repeated a credit';
 END IF;
 DELETE FROM club_members;
 FOREACH v_category IN ARRAY ARRAY['cashout','rakeback','tournament_prize','refund'] LOOP
  BEGIN
   PERFORM atomic_credit_wallet_and_log(v_user,25,v_category,'missing destination',v_table,NULL,NULL,'missing:'||v_category);
   RAISE EXCEPTION 'Missing destination was falsely acknowledged for %',v_category;
  EXCEPTION WHEN SQLSTATE '23503' THEN
   IF SQLERRM NOT LIKE 'CLUB_CREDIT_DESTINATION_MISSING:%' THEN RAISE; END IF;
  END;
 END LOOP;
 IF (SELECT count(*) FROM wallet_credit_idempotency) <> 4
    OR (SELECT count(*) FROM chip_transactions) <> 4
    OR (SELECT count(*) FROM wallet_transactions) <> 1 THEN
  RAISE EXCEPTION 'Failed credits left idempotency claims or journal entries';
 END IF;
 -- A retained, inactive club account still owns its payable balance.
 INSERT INTO club_members(user_id,club_id,chip_balance,status) VALUES(v_user,v_club,100,'left');
 PERFORM atomic_credit_wallet_and_log(v_user,25,'cashout','existing inactive destination',v_table,NULL,NULL,'inactive:cashout');
 IF (SELECT chip_balance FROM club_members) IS DISTINCT FROM 125::numeric THEN
  RAISE EXCEPTION 'Existing inactive account could not receive its owed cashout';
 END IF;
END $test$;
SELECT 'PASS: valid club credits, committed retry, missing-destination rollback, retained inactive account' AS result;
