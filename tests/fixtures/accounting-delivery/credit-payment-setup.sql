ALTER TABLE agents ADD COLUMN credit_used numeric DEFAULT 100,ADD COLUMN updated_at timestamptz;
ALTER TABLE credit_invoices ADD COLUMN amount_paid numeric DEFAULT 0,ADD COLUMN amount_remaining numeric DEFAULT 100,
 ADD COLUMN status text DEFAULT 'pending',ADD COLUMN paid_at timestamptz,ADD COLUMN void_reason text;
ALTER TABLE club_members ADD COLUMN chip_balance numeric DEFAULT 0;
CREATE FUNCTION fn_is_club_admin_uid(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT EXISTS(SELECT 1 FROM clubs WHERE id=$1 AND owner_id=auth.uid())$$;
CREATE FUNCTION fn_is_platform_admin() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE TABLE fixture_credit_debits(invoice_id uuid,club_id uuid,amount numeric);
CREATE TABLE ca_money_rpc_registry(proname text PRIMARY KEY,status text,notes text);
-- The debit adapter is isolated here; live rollback probes exercise the deployed wallet writer.
CREATE FUNCTION atomic_deduct_wallet_and_log(uuid,numeric,text,text,uuid,uuid,uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE scope uuid:=current_setting('app.ledger_club_id')::uuid;
BEGIN
 UPDATE club_members SET chip_balance=chip_balance-$2 WHERE user_id=$1 AND club_id=scope AND chip_balance >= $2;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO fixture_credit_debits VALUES($7,scope,$2);
 RETURN true;
END $$;
INSERT INTO club_members(club_id,user_id,role,status,chip_balance) VALUES
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','agent','active',100),
 ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','agent','active',1000);
