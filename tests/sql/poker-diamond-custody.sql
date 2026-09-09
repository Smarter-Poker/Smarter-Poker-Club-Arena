\set ON_ERROR_STOP on
DO $$ BEGIN
 IF current_database()<>'poker_diamond_phase3_test' OR inet_server_addr() IS NOT NULL
 OR current_setting('port')<>'55472' THEN RAISE EXCEPTION 'isolated phase3 fixture only'; END IF;
END $$;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role;
CREATE TABLE profiles(id uuid PRIMARY KEY,diamonds integer CHECK(diamonds>=0),diamond_balance integer,
 diamond_multiplier numeric DEFAULT 1,updated_at timestamptz);
CREATE TABLE clubs(id uuid PRIMARY KEY,asset text,is_platform boolean,union_id uuid);
CREATE TABLE club_members(club_id uuid,chip_balance numeric);
CREATE TABLE ca_money_rpc_registry(proname text PRIMARY KEY,status text,notes text);
CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,min_buy_in numeric,max_buy_in numeric,status text);
CREATE TABLE tournaments(id uuid PRIMARY KEY,club_id uuid,buy_in_amount numeric,buy_in_fee numeric,status text);
CREATE TABLE ca_arena_settings(id integer PRIMARY KEY,club_id uuid,settlement_window_days integer);
CREATE TABLE diamond_purchase_lots(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,purchase_id uuid,
 issued integer,consumed integer DEFAULT 0,refunded integer DEFAULT 0,frozen_at timestamptz,
 created_at timestamptz DEFAULT now(),settled_at timestamptz);
CREATE TABLE diamond_debts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,purchase_id uuid,
 amount integer,reason text,created_at timestamptz DEFAULT now(),settled_at timestamptz,settled_by text);
CREATE TABLE diamond_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,type text,
 transaction_type text,source text,amount integer,balance_after integer,description text,reference_id text,
 metadata jsonb,counterparty text,issuance_class text,created_at timestamptz DEFAULT now(),UNIQUE(user_id,reference_id));
CREATE TABLE ca_payout_freeze(scope text,cleared_at timestamptz);
CREATE TABLE fixture_incidents(rule text,details jsonb);
CREATE FUNCTION fn_ca_diamond_incident(text,text,uuid,numeric,text,jsonb) RETURNS void LANGUAGE sql AS $$
 INSERT INTO fixture_incidents VALUES($1,$6) $$;
CREATE FUNCTION fn_ca_diamond_rule_mode(text) RETURNS text LANGUAGE sql AS $$ SELECT 'refuse'::text $$;
CREATE FUNCTION fn_ca_journal_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'append only'; END $$;
CREATE TABLE ca_diamond_journal_archive(LIKE diamond_transactions INCLUDING DEFAULTS);
CREATE TABLE ca_mint_ledger(id uuid DEFAULT gen_random_uuid(),action text,amount numeric,asset text,
 holder_type text,holder_id uuid,created_at timestamptz DEFAULT now());
CREATE TABLE ca_diamond_house(id integer,balance numeric);
CREATE TABLE ca_diamond_house_ledger(delta numeric,at timestamptz);
CREATE TABLE ca_diamond_snapshots(id bigserial,taken_at timestamptz DEFAULT now(),arena_diamonds numeric,
 profile_diamonds numeric,wallet_diamonds numeric,cert_diamonds numeric,total numeric,journaled_delta numeric,
 delta_vs_prev numeric,unexplained numeric,register_supply numeric,house_balance numeric,
 fixture_diamonds numeric,register_fixture numeric);
CREATE TABLE diamond_wallets(user_id uuid,balance integer);
CREATE TABLE user_diamonds(user_id uuid,balance integer);
CREATE TABLE user_diamond_balance(user_id uuid,balance integer);
CREATE TABLE ca_cert_accounts(tagged_at timestamptz);
CREATE TABLE diamond_reward_budgets(period text,engine text,budget_diamonds bigint);
CREATE FUNCTION fn_ca_is_fixture_account(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE FUNCTION fn_ca_is_cert_account(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE FUNCTION fn_ca_diamond_offledger_float() RETURNS numeric LANGUAGE plpgsql AS $$ BEGIN RETURN fn_ca_arena_diamonds(); END $$;
CREATE FUNCTION fn_ca_mint_supply(text) RETURNS numeric LANGUAGE sql AS $$ SELECT COALESCE(sum(CASE WHEN action='mint' THEN amount ELSE -amount END),0) FROM ca_mint_ledger WHERE asset=$1 $$;
CREATE FUNCTION fn_ca_diamond_engine_spent(text,text) RETURNS numeric LANGUAGE sql AS $$ SELECT 0::numeric $$;
ALTER TABLE profiles ADD COLUMN username text, ADD COLUMN full_name text;
ALTER TABLE ca_mint_ledger ADD COLUMN op_id text UNIQUE, ADD COLUMN diamond_tx_id uuid UNIQUE,
 ADD COLUMN holder_label text, ADD COLUMN balance_before numeric, ADD COLUMN balance_after numeric,
 ADD COLUMN supply_after numeric, ADD COLUMN reason text, ADD COLUMN performed_by uuid,
 ADD COLUMN performed_by_label text, ADD COLUMN chip_ledger_id uuid;
\ir poker-diamond-production-register-fixture.sql
INSERT INTO clubs VALUES('20000000-0000-0000-0000-000000000001','diamonds',true,null);
INSERT INTO ca_arena_settings VALUES(1,'20000000-0000-0000-0000-000000000001',14);
\ir ../../supabase/migrations/20260909065458_poker_diamond_custody.sql
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS cron.job(jobname text,command text);
\ir ../../supabase/migrations/20260909164740_seal_diamond_custody_retry_doors_before_retirement.sql
\ir ../../supabase/migrations/20260909164847_diamond_custody_release_is_atomic_without_recovery.sql
\ir ../../supabase/migrations/20260909165003_diamond_internal_writers_are_service_only.sql
\ir ../../supabase/migrations/20260909165102_diamond_internal_writer_acl_contract_is_explicit.sql
CREATE FUNCTION fixture_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
 BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END $$;
INSERT INTO profiles(id,diamonds) VALUES('10000000-0000-0000-0000-000000000001',1000);
INSERT INTO tables VALUES('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',10,1000,'waiting');
INSERT INTO diamond_purchase_lots(user_id,issued,created_at) VALUES('10000000-0000-0000-0000-000000000001',500,now()-interval '30 days');
CREATE TEMP TABLE receipts AS SELECT fn_poker_diamond_reserve('10000000-0000-0000-0000-000000000001','cash_seat',
 '30000000-0000-0000-0000-000000000001','seat-1',300,'40000000-0000-0000-0000-000000000001') receipt;
SELECT fixture_assert((SELECT diamonds=700 FROM profiles),'reserve debits available');
SELECT fixture_assert(fn_ca_arena_diamonds()=300,'custody counts once');
SELECT fixture_assert((SELECT arena_reserved=300 AND consumed=0 FROM diamond_purchase_lots),'reserve preserves liability');
SELECT fixture_assert(fn_poker_diamond_reserve('10000000-0000-0000-0000-000000000001','cash_seat',
 '30000000-0000-0000-0000-000000000001','seat-1',300,'40000000-0000-0000-0000-000000000001')=(SELECT receipt FROM receipts),'replay receipt identical');
SELECT fixture_assert((SELECT count(*)=1 FROM diamond_transactions),'replay journals once');
SELECT fn_poker_diamond_release((SELECT (receipt->>'custody_id')::uuid FROM receipts),'50000000-0000-0000-0000-000000000001');
SELECT fixture_assert((SELECT diamonds=1000 FROM profiles),'release restores available');
SELECT fixture_assert(fn_ca_arena_diamonds()=0,'release empties custody');
SELECT fixture_assert((SELECT arena_reserved=0 AND consumed=0 FROM diamond_purchase_lots),'release preserves purchased provenance');
SELECT fixture_assert((SELECT sum(amount)=0 FROM diamond_transactions),'reserve release journal conserves');
SELECT fixture_assert(to_regclass('public.poker_diamond_obligations') IS NULL,'no recovery obligation table');
