ALTER TABLE table_seats ADD id uuid DEFAULT gen_random_uuid();
-- Isolate historical reporting from earlier scenarios. These are local fixtures.
TRUNCATE bbj_payout_recipients,bbj_recipient_reporting_owners,table_seats,signals;
CREATE TABLE history_money_before AS SELECT md5(coalesce(jsonb_agg(x)::text,'')) hash FROM club_members x;
-- 1: exact original seat, 2: duplicate agreeing witness, 3: conflicting club,
-- 4: later seat, 5: already departed, 6: unknown club, 7: existing owner,
-- 8: explicit display seed. Only 1 and 2 may be recovered.
DO $$ DECLARE i int; u uuid; p uuid; t uuid; BEGIN
 FOR i IN 1..8 LOOP
  u:=('a0000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid;
  p:=('b0000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid;
  t:=gen_random_uuid();
  INSERT INTO bbj_payouts(id,table_id,hand_number,kind,metadata) VALUES(p,t,888,'main','{"variant":"plo5"}');
  INSERT INTO bbj_payout_recipients VALUES(p,u,10*i,'2026-09-10 12:00Z');
  INSERT INTO table_seats(user_id,table_id,club_id,joined_at,left_at,stack) VALUES
   (u,t,CASE WHEN i<>6 THEN '10000000-0000-0000-0000-000000000001'::uuid END,
    CASE WHEN i=4 THEN '2026-09-10 13:00Z'::timestamptz ELSE '2026-09-10 10:00Z' END,
    CASE WHEN i=5 THEN '2026-09-10 12:00Z'::timestamptz ELSE '2026-09-10 14:00Z' END,100);
  IF i IN(2,3) THEN
   INSERT INTO table_seats(user_id,table_id,club_id,joined_at,left_at,stack) VALUES
    (u,t,CASE WHEN i=2 THEN '10000000-0000-0000-0000-000000000001'::uuid ELSE '10000000-0000-0000-0000-000000000002'::uuid END,'2026-09-10 10:00Z','2026-09-10 14:00Z',100);
  END IF;
  IF i=7 THEN
   INSERT INTO bbj_recipient_reporting_owners VALUES(p,u,'10000000-0000-0000-0000-000000000002','plo5','original_paid_evidence',now());
  END IF;
  IF i=8 THEN
   INSERT INTO hand_history(id,table_id,hand_number,source) VALUES(gen_random_uuid(),t,888,'seed');
  END IF;
 END LOOP;
END $$;
CREATE TABLE history_receipts_before AS SELECT * FROM bbj_payout_recipients;
CREATE TABLE history_seats_before AS SELECT * FROM table_seats;
