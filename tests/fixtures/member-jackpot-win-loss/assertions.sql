DO $$
DECLARE c uuid:='10000000-0000-0000-0000-000000000001'; u uuid:='20000000-0000-0000-0000-000000000001';
 d jsonb; s jsonb; r record; period text; start_at timestamptz; end_at timestamptz; payout uuid; i int:=0;
BEGIN
 d:=ca_club_member_win_loss(c,u);
 FOREACH period IN ARRAY ARRAY['today','week','month','overall'] LOOP
  IF (d->period->>'cash')::numeric<>619.20 THEN RAISE EXCEPTION 'Wrong award period %: %',period,d; END IF;
  SELECT * INTO r FROM ca_club_members_win_loss(c,ARRAY[u,u,NULL],period);
  IF r.net<>619.20 OR r.cash<>619.20 OR r.mtt<>0 THEN RAISE EXCEPTION 'Roster disagrees %',r; END IF;
 END LOOP;
 IF (ca_club_member_detail(c,u,NULL,NULL)->'stats'->>'total_winnings')::numeric<>619.20 THEN RAISE EXCEPTION 'Detail missing award'; END IF;
 s:=ca_club_member_statistics(c,u,'NLH',NULL,NULL);
 IF (s->>'net')::numeric<>619.20 OR (s-'net'-'variant') IS DISTINCT FROM (SELECT stats-'net'-'variant' FROM baseline)
 THEN RAISE EXCEPTION 'Stats altered non-money fields or missed award %',s; END IF;
 IF (ca_club_member_statistics(c,u,'plo4',NULL,NULL)->>'net')::numeric<>0 THEN RAISE EXCEPTION 'Wrong variant'; END IF;
 IF ca_club_member_jackpot_money('10000000-0000-0000-0000-000000000009',u,NULL,NULL)<>0 THEN RAISE EXCEPTION 'Shell club got award'; END IF;
 -- Retained authoritative ownership survives missing hand-stat facts.
 DELETE FROM ca_hand_facts WHERE user_id=u;
 IF ca_club_member_jackpot_money(c,u,NULL,NULL,'nlh')<>620.20 THEN RAISE EXCEPTION 'Retained award lost'; END IF;
 UPDATE union_pnl_cash_outcomes SET evidence='{"status":"blocked"}' WHERE table_id='30000000-0000-0000-0000-000000000001';
 IF ca_club_member_jackpot_money(c,u,NULL,NULL,'nlh')<>620.20 THEN RAISE EXCEPTION 'Original funding fallback lost'; END IF;
 DELETE FROM cash_participant_funding_receipts WHERE account_entity_id=u;
 BEGIN
  PERFORM ca_club_member_jackpot_money(c,u,NULL,NULL);
  RAISE EXCEPTION 'Missing ownership silently became zero';
 EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
 INSERT INTO rake_attributions VALUES('60000000-0000-0000-0000-000000000001',u,c);
 IF ca_club_member_jackpot_money(c,u,NULL,NULL)<>620.20 THEN RAISE EXCEPTION 'Recorded rake ownership fallback lost'; END IF;
 -- Both DST changes and Monday/month boundaries use inclusive start/exclusive end.
 FOR start_at,end_at IN VALUES
 ('2026-03-08 00:00 America/Chicago'::timestamptz,'2026-03-09 00:00 America/Chicago'::timestamptz),
 ('2026-11-01 00:00 America/Chicago'::timestamptz,'2026-11-02 00:00 America/Chicago'::timestamptz),
 ('2026-10-26 00:00 America/Chicago'::timestamptz,'2026-11-01 00:00 America/Chicago'::timestamptz)
 LOOP
  DELETE FROM bbj_payout_recipients WHERE user_id=u;
  FOR r IN SELECT * FROM (VALUES(start_at-interval '1 microsecond',100::numeric),(start_at,11),(end_at-interval '1 microsecond',22),(end_at,1000)) x(at,amount) LOOP
   payout:=gen_random_uuid();
   INSERT INTO bbj_payouts SELECT payout,pool_id,table_id,hand_id,hand_number,'mini' FROM bbj_payouts WHERE id='50000000-0000-0000-0000-000000000001';
   INSERT INTO bbj_payout_recipients VALUES(payout,u,r.amount,r.at);
  END LOOP;
  IF ca_club_member_jackpot_money(c,u,start_at,end_at)<>33 THEN RAISE EXCEPTION 'Award boundary failed'; END IF;
  PERFORM set_config('test.cutoff',(start_at+interval '1 microsecond')::text,true);
  IF ca_club_member_jackpot_money(c,u,start_at,end_at)<>22 THEN RAISE EXCEPTION 'Launch cutoff failed'; END IF;
  PERFORM set_config('test.cutoff','',true);
 END LOOP;
 PERFORM set_config('test.access','none',true);
 IF ca_club_member_win_loss(c,u) IS NOT NULL OR EXISTS(SELECT FROM ca_club_members_win_loss(c,ARRAY[u],'today'))
 THEN RAISE EXCEPTION 'Unauthorized result'; END IF;
 FOREACH period IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(period,'public.ca_club_member_jackpot_money(uuid,uuid,timestamptz,timestamptz,text)','EXECUTE') THEN RAISE EXCEPTION 'Private helper exposed'; END IF;
 END LOOP;
END $$;
-- The actual credit owner, with real unique claims and transactional seat writes.
SET ROLE postgres;
LISTEN jackpot_fixture_committed;
BEGIN;
SELECT bbj_credit_one_recipient('50000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',5,true);
ROLLBACK;
DO $$ BEGIN IF EXISTS(SELECT FROM signals) OR (SELECT stack FROM table_seats)<>720.20 THEN RAISE EXCEPTION 'Rollback escaped'; END IF; END $$;
SELECT bbj_credit_one_recipient('50000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',5,true);
SELECT bbj_credit_one_recipient('50000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',5,true);
DO $$ BEGIN IF (SELECT count(*) FROM signals)<>1 OR (SELECT stack FROM table_seats)<>725.20 THEN RAISE EXCEPTION 'Credit or signal duplicated'; END IF; END $$;
-- Departed player wallet route, same unique paid-receipt reader.
INSERT INTO bbj_payouts SELECT '50000000-0000-0000-0000-000000000002',pool_id,table_id,hand_id,hand_number,'mini' FROM bbj_payouts WHERE id='50000000-0000-0000-0000-000000000001';
SELECT bbj_credit_one_recipient('50000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',7,false);
DO $$ BEGIN IF (SELECT count(*) FROM signals)<>2 OR (SELECT chip_balance FROM club_members)<>107
 OR ca_club_member_jackpot_money('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',now()-interval '1 minute',now()+interval '1 minute')<>12
 THEN RAISE EXCEPTION 'Wallet award not counted once'; END IF; END $$;
-- A player with no wallet is parked, not reported as paid and never signaled.
SELECT bbj_credit_one_recipient('50000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000009',7,false);
DO $$ BEGIN IF (SELECT count(*) FROM signals)<>2 OR EXISTS(SELECT FROM bbj_payout_recipients WHERE user_id='20000000-0000-0000-0000-000000000009') THEN RAISE EXCEPTION 'Parked award reported'; END IF; END $$;
RESET ROLE;
