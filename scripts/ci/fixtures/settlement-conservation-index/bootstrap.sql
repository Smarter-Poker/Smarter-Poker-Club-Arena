CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('fixture.uid',true),'')::uuid $$;
CREATE FUNCTION u(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5(n::text)::uuid $$;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE TABLE unions(id uuid PRIMARY KEY);
CREATE TABLE clubs(id uuid PRIMARY KEY,chip_treasury numeric);
CREATE TABLE union_admins(union_id uuid,user_id uuid);
CREATE TABLE union_wallets(union_id uuid,chip_balance numeric,rake_wallet numeric);
CREATE TABLE wallets(user_id uuid,wallet_type text,balance numeric);
CREATE TABLE union_pnl_settlements(id uuid,union_id uuid,total_collected numeric,total_paid numeric,period_start timestamptz,settled_at timestamptz,status text);
CREATE TABLE chip_transactions(club_id uuid,amount numeric,created_at timestamptz,transaction_type text);
CREATE TABLE union_wallet_transactions(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  union_id uuid REFERENCES unions(id) ON DELETE CASCADE,
  amount numeric(20,4) CHECK(amount>0) CHECK(amount IS NULL OR amount=round(amount,2)),
  tx_type text NOT NULL,club_id uuid REFERENCES clubs(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz,wallet text CHECK(wallet IN('chip_balance','rake_wallet','bbj_wallet','promo_wallet','insurance_wallet','spin_reserve_wallet')),
  direction text CHECK(direction IN('credit','debit')),unrelated_payload text
);
ALTER TABLE union_wallet_transactions ADD CONSTRAINT ck_whole_cents CHECK(created_at<'2026-09-07 22:00:00+00'::timestamptz OR amount=round(amount,2)) NOT VALID;
ALTER TABLE union_wallet_transactions ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT SELECT ON union_admins,union_wallet_transactions TO authenticated;
GRANT ALL ON union_wallet_transactions TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;
CREATE POLICY union_admin_view_wallet_txns ON union_wallet_transactions FOR SELECT USING(EXISTS(SELECT 1 FROM union_admins WHERE union_admins.union_id=union_wallet_transactions.union_id AND union_admins.user_id=(SELECT auth.uid())));
CREATE INDEX idx_uwt_union_wallet_created ON union_wallet_transactions(union_id,wallet,created_at DESC) INCLUDE(amount,direction);
CREATE INDEX idx_union_wallet_transactions_club_id ON union_wallet_transactions(club_id);
CREATE TABLE fixture_clock AS SELECT now() AS at;
INSERT INTO auth.users VALUES(u(900));
INSERT INTO unions VALUES(u(1)),(u(2));
INSERT INTO clubs SELECT u(n),CASE WHEN n=20 THEN -1 ELSE 0 END FROM generate_series(10,20)n;
INSERT INTO union_admins VALUES(u(1),u(900));
INSERT INTO union_wallets VALUES(u(1),-2,0),(u(2),0,-3);
INSERT INTO wallets VALUES(u(21),'PLAYER',-4),(u(22),'OTHER',-99);
INSERT INTO union_pnl_settlements
SELECT u(100+n),u(1),CASE n WHEN 0 THEN 10 WHEN 1 THEN 10.01 WHEN 2 THEN 10.02 WHEN 3 THEN 0 WHEN 4 THEN 99 WHEN 5 THEN 99 WHEN 6 THEN NULL END,
 CASE n WHEN 0 THEN 7.77 WHEN 3 THEN 12 ELSE 0 END,
 at-(20-n)*interval '1 day',CASE WHEN n=5 THEN NULL ELSE at-(20-n)*interval '1 day'+interval '1 hour' END,
 CASE WHEN n=4 THEN 'pending' ELSE 'settled' END
FROM generate_series(0,6)n CROSS JOIN fixture_clock;
INSERT INTO union_wallet_transactions(union_id,amount,tx_type,club_id,created_at,wallet,direction)
SELECT u(1),v.amount,v.kind,u(10),s.period_start+v.offset_time,'chip_balance','credit'
FROM (VALUES(100,5::numeric,'player_pnl_collect',interval '0'),(100,5,'player_pnl_collect',interval '61 minutes'),(100,7.77,'player_pnl_pay',interval '30 minutes'),(101,10,'player_pnl_collect',interval '30 minutes'),(102,10,'player_pnl_collect',interval '30 minutes'),(103,11,'player_pnl_pay',interval '30 minutes'))v(id,amount,kind,offset_time)
JOIN union_pnl_settlements s ON s.id=u(v.id);
-- An unrelated type and the first instant outside the inclusive upper bound
-- must not enter the balanced settlement's sum.
INSERT INTO union_wallet_transactions(union_id,amount,tx_type,club_id,created_at,wallet,direction)
SELECT u(1),99,v.kind,u(10),s.settled_at+v.offset_time,'chip_balance','credit'
FROM (VALUES('rake',interval '0'),('player_pnl_collect',interval '1 minute 0.001 seconds'))v(kind,offset_time)
CROSS JOIN union_pnl_settlements s WHERE s.id=u(100);
INSERT INTO chip_transactions SELECT CASE WHEN n=17 THEN NULL ELSE u(n) END,n-9,at-CASE WHEN n=18 THEN interval '91 days' ELSE interval '1 day' END,'union_hold' FROM generate_series(10,18)n CROSS JOIN fixture_clock;
INSERT INTO union_wallet_transactions(union_id,amount,tx_type,club_id,created_at,wallet,direction)
SELECT u(1),v.amount,v.kind,u(v.club),at-interval '1 day'+v.offset_time,'chip_balance','credit'
FROM (VALUES(10,1::numeric,'settlement_hold',interval '-5 minutes'),(11,2,'settlement_hold',interval '5 minutes'),(12,3,'settlement_hold',interval '0'),(13,4.01,'settlement_hold',interval '0'),(15,6,'other',interval '0'),(16,7,'settlement_hold',interval '5 minutes 0.001 seconds'))v(club,amount,kind,offset_time) CROSS JOIN fixture_clock;
-- Predominantly unrelated receipts model the actual hot table; both included
-- monetary and UUID values remain bounded even at their representable extremes.
INSERT INTO union_wallet_transactions(union_id,amount,tx_type,club_id,created_at,wallet,direction,unrelated_payload)
SELECT CASE WHEN n%2=0 THEN u(1) ELSE u(2) END,1,'rake',u(10),at-n*interval '1 minute','rake_wallet','credit',repeat(md5(n::text),16)
FROM generate_series(1,150000)n CROSS JOIN fixture_clock;
INSERT INTO union_wallet_transactions(union_id,amount,tx_type,club_id,created_at,wallet,direction)
SELECT u(2),9999999999999999.99,'player_pnl_collect',NULL,at,'chip_balance','credit' FROM fixture_clock;
INSERT INTO union_wallet_transactions(union_id,amount,tx_type,club_id,created_at,wallet,direction)
SELECT u(2),NULL,'settlement_hold',NULL,at,'chip_balance','credit' FROM fixture_clock;
VACUUM ANALYZE union_wallet_transactions;
ANALYZE union_pnl_settlements;
ANALYZE chip_transactions;
