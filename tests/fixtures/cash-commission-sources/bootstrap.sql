CREATE TABLE auth.users(id uuid PRIMARY KEY);
INSERT INTO auth.users SELECT u(n) FROM generate_series(1,300) n;
ALTER TABLE agents ADD COLUMN lifetime_rake_generated numeric,ADD COLUMN last_active_at timestamptz,ADD COLUMN updated_at timestamptz;
CREATE TABLE ca_money_rpc_registry(proname text PRIMARY KEY,status text,notes text);
CREATE TABLE agent_commissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,user_id uuid,amount numeric,commission_rate numeric,source_type text,source_id uuid,notes text,created_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX uq_agent_commissions_source ON agent_commissions(user_id,source_id,source_type) WHERE source_id IS NOT NULL;
CREATE TABLE agent_commission_settlements(club_id uuid,user_id uuid,period_start timestamptz,period_end timestamptz);
CREATE TABLE accounting_routed_settlement_runs(union_id uuid,standalone_club_id uuid,period_start timestamptz,period_end timestamptz);
CREATE TABLE union_rakeback_log(union_id uuid,period_start timestamptz,period_end timestamptz);
CREATE FUNCTION fn_union_week_start(t timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT date_trunc('week',t AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles'$$;
CREATE FUNCTION test_commission_delivery_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF current_setting('test.fail_commission',true)='true' AND NEW.user_id=u(31) THEN RAISE EXCEPTION 'commission journal unavailable';END IF;RETURN NEW;END$$;
CREATE TRIGGER test_commission_fail BEFORE INSERT ON agent_commissions FOR EACH ROW EXECUTE FUNCTION test_commission_delivery_failure();

CREATE FUNCTION fn_is_union_overseer(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;

ALTER TABLE hand_history ADD COLUMN started_at timestamptz;
CREATE TABLE table_seats(table_id uuid,user_id uuid,club_id uuid,joined_at timestamptz,left_at timestamptz);
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;

CREATE TABLE union_wallet_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),created_at timestamptz DEFAULT now(),union_id uuid,club_id uuid,amount numeric,tx_type text,wallet text,direction text,balance_after numeric,notes text);
CREATE TABLE chip_ledger(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),created_at timestamptz DEFAULT now(),performed_by uuid,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,amount numeric,category text,club_id uuid,table_id uuid,hand_id uuid,tournament_id uuid,description text);
