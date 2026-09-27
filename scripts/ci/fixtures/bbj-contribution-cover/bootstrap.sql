CREATE ROLE authenticated;
CREATE ROLE service_role;
GRANT authenticated,service_role TO postgres;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION public.fn_is_club_admin_uid(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid()='00000000-0000-0000-0000-000000000001'::uuid $$;
CREATE FUNCTION u(integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT lpad($1::text,32,'0')::uuid$$;
CREATE TABLE public.clubs(id uuid PRIMARY KEY,union_id uuid,promo_balance numeric(14,2));
CREATE TABLE public.bbj_pools(id uuid PRIMARY KEY,club_id uuid,union_id uuid,promo_balance numeric(14,2));
CREATE TABLE public.union_wallets(union_id uuid,promo_wallet numeric(14,2));
CREATE TABLE public.union_wallet_transactions(union_id uuid,tx_type text,amount numeric(14,2));
CREATE TABLE public.chip_transactions(club_id uuid,transaction_type text,amount numeric(14,2));
CREATE TABLE public.bbj_contributions(
 id uuid PRIMARY KEY,pool_id uuid,club_id uuid,table_id uuid,hand_number bigint,
 amount numeric(14,2),big_blind numeric(10,2),stakes_tier text,created_at timestamptz,
 main_portion numeric(10,4),backup_portion numeric(10,4),promo_portion numeric(10,4),hand_id uuid
);
ALTER TABLE bbj_contributions ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_bbj_contrib_pool_created ON bbj_contributions(pool_id,created_at) INCLUDE(backup_portion);
INSERT INTO clubs VALUES(u(1),null,10),(u(2),u(20),30);
INSERT INTO bbj_pools VALUES(u(10),u(1),null,1),(u(11),null,u(20),2),(u(12),u(2),null,0);
INSERT INTO union_wallets VALUES(u(20),80);
INSERT INTO union_wallet_transactions VALUES(u(20),'bbj_promo_sweep',10);
INSERT INTO chip_transactions VALUES(u(1),'bbj_promo_sweep',15);
INSERT INTO bbj_contributions
SELECT u(100+n),CASE WHEN n%10=0 THEN u(11) ELSE u(10) END,u(1),u(3),n,
 CASE WHEN n%31=0 THEN null ELSE (n%9-4)::numeric/100 END,1,
 md5(n::text)||md5((n+1)::text)||md5((n+2)::text)||md5((n+3)::text),
 '2026-09-01'::timestamptz + (n||' seconds')::interval,0.015,
 CASE WHEN n%23=0 THEN null ELSE 0.0025 END,
 CASE WHEN n%17=0 THEN null ELSE 0.002 END,u(100+n)
FROM generate_series(1,150000)n;
INSERT INTO bbj_contributions(id,pool_id,amount,created_at,promo_portion) VALUES
 (u(200001),u(12),0,'2026-09-01',0),(u(200002),u(12),null,null,null),
 (u(200003),null,5,'2026-08-01',1);
VACUUM ANALYZE bbj_contributions;
