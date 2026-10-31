DO $$ BEGIN
 IF (SELECT count(*) FROM bbj_recipient_reporting_owners)<>3 OR (SELECT count(*) FROM signals)<>2 THEN
  RAISE EXCEPTION 'Historical seat recovery missed/duplicated or guessed ownership'; END IF;
 IF ca_club_member_jackpot_money('10000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001',NULL,NULL,'plo5')<>10
 OR ca_club_member_jackpot_money('10000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002',NULL,NULL,'plo5')<>20
 THEN RAISE EXCEPTION 'Historical recovered amounts differ'; END IF;
 IF EXISTS((SELECT * FROM bbj_payout_recipients EXCEPT SELECT * FROM history_receipts_before) UNION ALL
 (SELECT * FROM history_receipts_before EXCEPT SELECT * FROM bbj_payout_recipients))
 OR EXISTS((SELECT * FROM table_seats EXCEPT SELECT * FROM history_seats_before) UNION ALL
 (SELECT * FROM history_seats_before EXCEPT SELECT * FROM table_seats))
 OR (SELECT md5(coalesce(jsonb_agg(x)::text,'')) FROM club_members x)<>(SELECT hash FROM history_money_before)
 THEN RAISE EXCEPTION 'Reporting recovery moved money'; END IF;
 BEGIN
  PERFORM ca_club_member_jackpot_money('10000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000003',NULL,NULL);
  RAISE EXCEPTION 'Ambiguous club reported as known';
 EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
 IF (SELECT jsonb_array_length(substring(source from length('original_seat_occupancy:')+1)::jsonb)
 FROM bbj_recipient_reporting_owners WHERE user_id='a0000000-0000-0000-0000-000000000002')<>2 THEN
  RAISE EXCEPTION 'Original witnesses not retained'; END IF;
END $$;
