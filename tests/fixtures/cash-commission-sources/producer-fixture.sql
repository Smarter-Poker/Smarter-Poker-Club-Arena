ALTER TABLE clubs ADD COLUMN name text,ADD COLUMN chip_treasury numeric DEFAULT 0,ADD COLUMN total_rake numeric DEFAULT 0,ADD COLUMN updated_at timestamptz;
ALTER TABLE rake_records ALTER COLUMN id SET DEFAULT gen_random_uuid(),ALTER COLUMN created_at SET DEFAULT now(),ADD COLUMN bbj_contribution numeric,ADD COLUMN pot_size numeric,ADD COLUMN num_players int,ADD COLUMN player_contributions jsonb,ADD COLUMN source text,ADD COLUMN rake_method text,ADD COLUMN returned_uncalled jsonb;
CREATE UNIQUE INDEX rake_records_hand ON rake_records(hand_id) WHERE hand_id IS NOT NULL;
ALTER TABLE rake_attributions ALTER COLUMN id SET DEFAULT gen_random_uuid(),ADD COLUMN table_id uuid,ADD COLUMN rake_amount numeric,ADD COLUMN gross_contribution numeric,ADD COLUMN returned_uncalled numeric,ADD COLUMN eligible_contribution numeric,ADD COLUMN contribution_weight numeric,ADD COLUMN bbj_attributed_contribution numeric,ADD COLUMN rake_method text;
ALTER TABLE hand_history ADD COLUMN created_at timestamptz DEFAULT now();
CREATE TABLE tables(id uuid PRIMARY KEY,is_private boolean,union_id uuid);
CREATE TABLE tournaments(id uuid PRIMARY KEY,is_private boolean,union_id uuid);
CREATE TABLE rake_distribution_legs(leg_key uuid,leg text,club_id uuid,union_id uuid,amount numeric,UNIQUE(leg_key,leg));
CREATE TABLE club_wallets(club_id uuid PRIMARY KEY,chip_balance numeric DEFAULT 0,period_rake_collected numeric DEFAULT 0,period_bbj_contribution numeric DEFAULT 0,lifetime_rake_collected numeric DEFAULT 0,lifetime_bbj_contribution numeric DEFAULT 0,updated_at timestamptz);
CREATE TABLE club_wallet_transactions(club_id uuid,type text,amount numeric,balance_after numeric,related_id uuid,reason text);
CREATE TABLE union_wallets(union_id uuid PRIMARY KEY,chip_balance numeric,rake_wallet numeric,total_rake_collected numeric,updated_at timestamptz);
CREATE TABLE financial_alerts(severity text,source text,message text,context jsonb);
-- Non-union cash rake is retired, even when its hosting club belongs to a union.
INSERT INTO tables VALUES(u(200),false,NULL),(u(210),false,u(20));
INSERT INTO hand_history(id,table_id,hand_number,started_at) VALUES(u(201),u(200),1000002,now()-interval '1 minute'),(u(211),u(210),1000003,now()-interval '1 minute');
INSERT INTO table_seats VALUES(u(210),u(12),u(10),now()-interval '2 minutes',NULL);
CREATE TEMP TABLE standalone_first AS SELECT * FROM atomic_distribute_rake(u(200),u(10),u(201),1000002,1,0,20,1,jsonb_build_object(u(12)::text,20),NULL,NULL,'WEIGHTED_CONTRIBUTED');
SELECT assert_true((SELECT chip_treasury FROM clubs WHERE id=u(10))=0 AND NOT EXISTS(SELECT 1 FROM union_wallets),'standalone cash never credits the club treasury or the union');
SELECT assert_true((SELECT applied AND spendable_route='chip_retirement' AND spendable_amount=0 AND club_net_credit=0 FROM standalone_first),
 'the actual producer receipt never presents burned rake as spendable credit');
SELECT assert_true((SELECT metadata->>'accounting_source_version'='2' AND metadata ? 'union_id' AND metadata->'union_id'='null'::jsonb FROM rake_records WHERE hand_id=u(201)),'the actual rake producer records its game-owned union stamp');
SELECT * FROM atomic_distribute_rake(u(210),u(20),u(211),1000003,2,0,20,1,jsonb_build_object(u(12)::text,20),NULL,NULL,'WEIGHTED_CONTRIBUTED');
SELECT assert_true((SELECT rake_wallet FROM union_wallets WHERE union_id=u(20))=2 AND (SELECT club_id FROM rake_attributions WHERE hand_id=u(211))=u(10),'the actual shared-table producer keeps the seat club while routing rake to union');
SELECT assert_true((SELECT metadata->>'union_id'=u(20)::text FROM rake_records WHERE hand_id=u(211)),'shared-table source retains the actual game union');
SELECT * FROM atomic_distribute_rake(u(210),u(20),u(211),1000003,2,0,20,1,jsonb_build_object(u(12)::text,20),NULL,NULL,'WEIGHTED_CONTRIBUTED');
SELECT assert_true((SELECT rake_wallet FROM union_wallets WHERE union_id=u(20))=2 AND (SELECT count(*) FROM rake_records WHERE hand_id=u(211))=1,'producer replay still banks each rake source once');
SELECT assert_true((SELECT count(*)=1 AND sum(b.amount)=2 FROM accounting_cash_bank_receipts b JOIN union_wallet_transactions t ON t.id=b.union_transaction_id JOIN rake_records r ON r.id=b.rake_record_id WHERE r.hand_id=u(211) AND b.union_id=t.union_id AND b.amount=t.amount AND b.banked_at=t.created_at),'union earning source names its exact bank deposit once');
SELECT assert_true((SELECT count(*)=1 AND sum(b.amount)=1 FROM accounting_cash_bank_receipts b JOIN chip_ledger l ON l.id=b.club_ledger_id JOIN rake_records r ON r.id=b.rake_record_id WHERE r.hand_id=u(201) AND b.union_id IS NULL AND b.amount=l.amount AND b.banked_at=l.created_at AND l.from_type='table_stack' AND l.to_type='chip_retirement' AND l.to_entity_id IS NULL AND l.category='burn'),'private earning source names its exact retirement leg');
SELECT assert_true(refuses('UPDATE accounting_cash_bank_receipts SET amount=99','55000'),'source-to-bank receipt is immutable');
-- A duplicate source preserves complete rows, not merely the treasury total.
CREATE TEMP VIEW test_cash_producer_rows AS SELECT jsonb_build_object(
 'clubs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM clubs r),
 'wallets',(SELECT jsonb_agg(to_jsonb(r) ORDER BY club_id) FROM club_wallets r),
 'rake',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM rake_records r),
 'attributions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM rake_attributions r),
 'legs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY leg_key,leg) FROM rake_distribution_legs r),
 'journal',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM chip_ledger r),
 'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY rake_record_id) FROM accounting_cash_bank_receipts r)
) AS rows;
CREATE TEMP TABLE test_cash_producer_before AS SELECT rows FROM test_cash_producer_rows;
SELECT * FROM atomic_distribute_rake(u(200),u(10),u(201),1000002,1,0,20,1,jsonb_build_object(u(12)::text,20),NULL,NULL,'WEIGHTED_CONTRIBUTED');
SELECT assert_true((SELECT rows FROM test_cash_producer_rows)=(SELECT rows FROM test_cash_producer_before),
 'standalone burn replay preserves every original source, counter, leg, journal and receipt row');
BEGIN;
ALTER TABLE chip_ledger DISABLE TRIGGER USER;
UPDATE chip_ledger SET to_type='club_treasury',to_entity_id=u(10),category='rake' WHERE hand_id=u(201);
TRUNCATE test_cash_producer_before;INSERT INTO test_cash_producer_before SELECT rows FROM test_cash_producer_rows;
SELECT assert_true(refuses('SELECT * FROM atomic_distribute_rake(u(200),u(10),u(201),1000002,1,0,20,1,jsonb_build_object(u(12)::text,20),NULL,NULL,''WEIGHTED_CONTRIBUTED'')','55000'),
 'legacy treasury disposition cannot be relabeled or burned again');
SELECT assert_true((SELECT rows FROM test_cash_producer_rows)=(SELECT rows FROM test_cash_producer_before),
 'legacy treasury refusal leaves all original rows unchanged');
ROLLBACK;
CREATE FUNCTION test_retirement_journal_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.to_type='chip_retirement' THEN RAISE EXCEPTION 'retirement journal unavailable';END IF;RETURN NEW;END$$;
CREATE TRIGGER test_retirement_journal_failure BEFORE INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION test_retirement_journal_failure();
SELECT assert_true(refuses('SELECT * FROM atomic_distribute_rake(u(200),u(10),u(204),1000006,1,0,20,1,jsonb_build_object(u(12)::text,20),NULL,NULL,''WEIGHTED_CONTRIBUTED'')','P0001'),
 'retirement journal failure refuses the original producer transaction');
SELECT assert_true((SELECT rows FROM test_cash_producer_rows)=(SELECT rows FROM test_cash_producer_before),
 'retirement journal failure rolls back every counter, raw source and disposition row');
DROP TRIGGER test_retirement_journal_failure ON chip_ledger;

CREATE FUNCTION test_bank_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'bank source proof unavailable';END$$;
CREATE TRIGGER test_bank_receipt_failure BEFORE INSERT ON accounting_cash_bank_receipts FOR EACH ROW EXECUTE FUNCTION test_bank_receipt_failure();
SELECT assert_true(refuses('SELECT * FROM atomic_distribute_rake(u(200),u(10),u(202),1000004,1,0,20,1,jsonb_build_object(u(12)::text,20),NULL,NULL,''WEIGHTED_CONTRIBUTED'')','P0001'),'bank receipt failure refuses the complete producer transaction');
SELECT assert_true((SELECT chip_treasury FROM clubs WHERE id=u(10))=0 AND NOT EXISTS(SELECT 1 FROM rake_records WHERE hand_id=u(202)),'failed bank proof leaves neither credits nor an unbacked earning source');
DROP TRIGGER test_bank_receipt_failure ON accounting_cash_bank_receipts;

SELECT assert_true((SELECT rows FROM test_cash_producer_rows)=(SELECT rows FROM test_cash_producer_before),
 'immutable receipt failure rolls back every producer row, including counters and retirement journal');
