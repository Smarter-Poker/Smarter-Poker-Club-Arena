CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '10000000-0000-0000-0000-000000000001'::uuid $$;
CREATE TABLE clubs(id uuid PRIMARY KEY,promo_balance numeric,updated_at timestamptz);
CREATE TABLE agents(id uuid PRIMARY KEY,user_id uuid,club_id uuid,agent_wallet_balance numeric,promo_wallet_balance numeric,updated_at timestamptz);
CREATE TABLE unions(id uuid PRIMARY KEY);
CREATE TABLE union_wallets(id uuid PRIMARY KEY,union_id uuid);
CREATE TABLE ca_ledger_replay_readings(read_snapshot text,committed_legs uuid[]);
CREATE FUNCTION fn_ca_xid8(xid) RETURNS xid8 LANGUAGE sql IMMUTABLE AS $$ SELECT $1::text::xid8 $$;
CREATE TABLE chip_ledger(id uuid DEFAULT gen_random_uuid(),performed_by uuid,from_type text CONSTRAINT chip_ledger_from_type_check CHECK(from_type IN ('promo_wallet','player_wallet','agent_wallet','union_wallet','settlement_suspense')),from_entity_id uuid,from_label text,to_type text,to_entity_id uuid,to_label text,amount numeric,category text CONSTRAINT chip_ledger_category_check CHECK(category IN ('promo_send','adjustment')),club_id uuid,union_id uuid,tournament_id uuid,description text,pre_from_balance numeric,post_from_balance numeric,pre_to_balance numeric,post_to_balance numeric,metadata jsonb,created_at timestamptz DEFAULT clock_timestamp());
CREATE TABLE club_members(club_id uuid,user_id uuid,role text,status text,chip_balance numeric,updated_at timestamptz,PRIMARY KEY(club_id,user_id));
CREATE TABLE chip_transactions(id uuid DEFAULT gen_random_uuid(),club_id uuid,from_user_id uuid,to_user_id uuid,amount numeric,transaction_type text,notes text,metadata jsonb,balance_after numeric);
-- Explicit fixture dependencies: permission/identity, not payment/journal behavior.
CREATE FUNCTION fn_club_bank_role(uuid) RETURNS text LANGUAGE sql AS $$SELECT 'owner'::text$$;
CREATE FUNCTION fn_club_cashier_can_transact(uuid,uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
CREATE FUNCTION fn_ensure_agent_row(uuid,uuid,text) RETURNS uuid LANGUAGE sql AS $$SELECT id FROM agents WHERE club_id=$1 AND user_id=$2$$;
