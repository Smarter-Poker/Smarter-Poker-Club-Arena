
ALTER TABLE club_members ADD COLUMN role text DEFAULT 'owner',ADD COLUMN status text DEFAULT 'active',ADD COLUMN updated_at timestamptz;
CREATE UNIQUE INDEX member_scope ON club_members(club_id,user_id);
ALTER TABLE chip_transactions ADD COLUMN metadata jsonb,ADD COLUMN reversible_until timestamptz,ADD COLUMN is_reversed boolean DEFAULT false,ADD COLUMN clawed_back boolean DEFAULT false,ALTER COLUMN id SET DEFAULT gen_random_uuid();
CREATE TABLE agents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,user_id uuid,agent_wallet_balance numeric DEFAULT 0,credit_used numeric DEFAULT 0,credit_limit numeric DEFAULT 100,is_prepaid boolean DEFAULT false,updated_at timestamptz,UNIQUE(club_id,user_id));
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
CREATE FUNCTION fn_club_bank_role(uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'owner'::text $$;
CREATE FUNCTION fn_club_cashier_can_transact(uuid,uuid,uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE FUNCTION fn_ensure_agent_row(uuid,uuid,text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM agents WHERE club_id=$1 AND user_id=$2 $$;
ALTER TABLE chip_ledger ADD CONSTRAINT chip_ledger_category_check CHECK(category IN ('agent_send','agent_claim','credit_draw','credit_repayment','outside'));
ALTER TABLE chip_ledger ADD CONSTRAINT chip_ledger_from_type_check CHECK(from_type IN ('agent_wallet','player_wallet','credit_facility','outside'));
CREATE TRIGGER member_journal AFTER UPDATE OF chip_balance ON club_members FOR EACH ROW EXECUTE FUNCTION fn_club_members_ledger_writer();
CREATE TRIGGER agent_journal AFTER UPDATE OF agent_wallet_balance ON agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('agent_wallet_balance=agent_wallet');
