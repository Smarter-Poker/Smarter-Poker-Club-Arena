ALTER TABLE club_wallets ADD COLUMN insurance_balance numeric(14,2) DEFAULT 0;
ALTER TABLE union_wallets ADD COLUMN insurance_wallet numeric(14,2) DEFAULT 0;
ALTER TABLE chip_ledger DROP CONSTRAINT chip_ledger_category_check;
ALTER TABLE chip_ledger ADD CONSTRAINT chip_ledger_category_check CHECK(category IN ('adjustment','insurance')) NOT VALID;
ALTER TABLE chip_ledger DROP CONSTRAINT chip_ledger_from_type_check;
ALTER TABLE chip_ledger ADD CONSTRAINT chip_ledger_from_type_check CHECK(from_type IN ('table_stack','insurance_bank','union_wallet','settlement_suspense')) NOT VALID;
CREATE TABLE insurance_transactions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),table_id uuid,club_id uuid,union_id uuid,hand_number integer,
 player_id uuid,equity_percent numeric(5,2),premium numeric(10,2),insured_amount numeric(10,2),payout numeric(10,2),
 player_won boolean,net_result numeric(10,2),bank_type varchar(10),bank_entity_id uuid,kind varchar,created_at timestamptz DEFAULT now(),
 UNIQUE(table_id,hand_number,player_id));
CREATE TRIGGER insurance_club_journal AFTER INSERT OR UPDATE OF insurance_balance ON club_wallets
 FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('insurance_balance=insurance_bank');
CREATE TRIGGER insurance_union_journal AFTER INSERT OR UPDATE OF insurance_wallet ON union_wallets
 FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('insurance_wallet=union_wallet');
