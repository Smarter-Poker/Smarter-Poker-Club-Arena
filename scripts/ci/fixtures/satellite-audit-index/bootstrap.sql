CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE FUNCTION u(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5(n::text)::uuid $$;
CREATE TABLE tournaments(id uuid PRIMARY KEY,name text,satellite_target_id uuid,status text,ended_at timestamptz,prize_pool numeric,satellite_seats integer,buy_in_amount numeric,buy_in_fee numeric);
CREATE TABLE tournament_escrow(tournament_id uuid PRIMARY KEY,prize_out numeric,prize_balance numeric);
CREATE TABLE chip_ledger(from_type text,from_entity_id uuid,category text,idempotency_key text,amount numeric);
CREATE TABLE tournament_players(tournament_id uuid,user_id uuid,position integer);
CREATE TABLE rake_records(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,source text,metadata jsonb,unrelated_payload text);
CREATE TABLE tournament_tickets(source_satellite_id uuid,holder_id uuid,status text);
CREATE TABLE tournament_satellite_awards(tournament_id uuid,place integer,delivery_kind text);
CREATE TABLE tournament_payouts(tournament_id uuid,user_id uuid,position integer,source text);
CREATE TABLE wallet_transactions(related_entity_id uuid,user_id uuid,amount numeric,category text,type text);
CREATE TABLE tournament_conservation_baseline(tournament_id uuid,amount numeric);
ALTER TABLE rake_records ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON rake_records TO authenticated;
CREATE POLICY fixture_own_receipts ON rake_records TO authenticated USING(metadata->>'user_id'=current_setting('fixture.uid',true));
INSERT INTO tournaments VALUES(u(900),'Target',NULL,'RUNNING',NULL,0,0,10,0);
INSERT INTO tournaments SELECT u(n),'Satellite '||n,u(900),'COMPLETED',now()-interval '1 hour',100,0,0,0 FROM generate_series(1,5)n;
INSERT INTO tournament_players SELECT u(n),u(1000+n*10+x),x FROM generate_series(1,5)n CROSS JOIN generate_series(1,10)x;
INSERT INTO tournament_escrow VALUES(u(1),0,100);
-- Real seat, overlapping ticket/payout, held ticket, cancelled ticket, and cash payout.
INSERT INTO rake_records(source,metadata) VALUES('fn_award_satellite_seat',jsonb_build_object('satellite_id',u(1),'user_id',u(1011))),('fn_award_satellite_seat',jsonb_build_object('satellite_id',u(1),'user_id',u(1011)));
INSERT INTO tournament_tickets VALUES(u(1),u(1011),'redeemed'),(u(1),u(1012),'issued'),(u(1),u(1013),'cancelled');
INSERT INTO tournament_satellite_awards VALUES(u(1),1,'seat'),(u(1),4,'cash'),(u(2),1,'ticket');
INSERT INTO tournament_payouts VALUES(u(1),u(1011),1,'satellite_seat'),(u(1),u(1014),4,'satellite_ticket'),(u(2),u(1021),1,'satellite_ticket');
INSERT INTO wallet_transactions VALUES(u(1),u(1013),10,'prize','credit'),(u(1),u(1014),10,'prize','credit');
INSERT INTO tournament_conservation_baseline VALUES(u(3),5);
INSERT INTO chip_ledger VALUES('prize_liability',u(4),'tournament_buyin','tourney:'||u(4)::text||':seat:1:pool_transfer',10);
-- Sparse exact-source matches interleaved with unrelated wide rows. All local synthetic.
INSERT INTO rake_records(source,metadata,unrelated_payload)
SELECT CASE WHEN n%1000=0 THEN 'fn_award_satellite_seat' ELSE 'cash_hand' END,
CASE WHEN n%1000=0 THEN jsonb_build_object('satellite_id',u(5),'user_id',u(5000+n)) ELSE jsonb_build_object('not_a_satellite_id','not-a-uuid','receipt',n) END,
repeat(md5(n::text),12) FROM generate_series(1,200000)n;
VACUUM ANALYZE rake_records;
