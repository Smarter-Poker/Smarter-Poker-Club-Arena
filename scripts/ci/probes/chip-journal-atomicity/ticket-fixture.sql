
ALTER TABLE club_members ADD COLUMN role text DEFAULT 'owner',ADD COLUMN status text DEFAULT 'active',ADD COLUMN agent_id uuid,ADD COLUMN updated_at timestamptz;
CREATE UNIQUE INDEX member_scope ON club_members(club_id,user_id);
ALTER TABLE chip_transactions ADD COLUMN metadata jsonb,ALTER COLUMN id SET DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX cashier_key ON chip_transactions((metadata->>'idempotency_key')) WHERE metadata ? 'idempotency_key';
CREATE TABLE tournament_tickets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,issued_by uuid,holder_id uuid,value numeric,note text,status text DEFAULT 'issued',cancelled_at timestamptz,redeemed_at timestamptz);
CREATE TABLE wallet_transactions(user_id uuid,wallet_type text,type text,amount numeric,category text,description text,balance_after numeric);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
CREATE FUNCTION fn_club_cashier_can_transact(uuid,uuid,uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE TRIGGER member_journal AFTER UPDATE OF chip_balance ON club_members FOR EACH ROW EXECUTE FUNCTION fn_club_members_ledger_writer();
