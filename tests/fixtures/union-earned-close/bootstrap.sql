CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE FUNCTION fn_union_week_start(timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$SELECT date_trunc('week',$1 AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles'$$;
ALTER TABLE clubs ADD COLUMN chip_treasury numeric DEFAULT 0,ADD COLUMN updated_at timestamptz,ADD COLUMN union_id uuid,ADD COLUMN is_union boolean DEFAULT false;
ALTER TABLE union_wallets ADD PRIMARY KEY(union_id),ADD COLUMN rake_wallet numeric DEFAULT 0,ADD COLUMN chip_balance numeric DEFAULT 0,ADD COLUMN total_settlements numeric DEFAULT 0,ADD COLUMN updated_at timestamptz;
ALTER TABLE ca_settlements ADD COLUMN error_detail text;
CREATE UNIQUE INDEX test_one_settlement_scope ON ca_settlements(settlement_type,external_ref);
CREATE TABLE union_wallet_transactions(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,union_id uuid,club_id uuid,amount numeric,tx_type text,wallet text,direction text,balance_after numeric,notes text,created_at timestamptz DEFAULT now());
CREATE TABLE union_rakeback_log(union_id uuid,period_start timestamptz,period_end timestamptz,total_rakeback numeric,executed_at timestamptz,UNIQUE(union_id,period_start,period_end));
CREATE TABLE union_settlement_floor(union_id uuid,earliest_period_start timestamptz);
CREATE TABLE settlement_locks(lock_type text,is_active boolean);
CREATE TABLE accounting_cash_accrual_cutover(singleton boolean PRIMARY KEY,starts_at timestamptz);
CREATE TABLE accounting_agreement_history(id bigint PRIMARY KEY,entity_type text,entity_key text,club_id uuid,observed_at timestamptz,after_terms jsonb);
CREATE TABLE rake_records(id uuid PRIMARY KEY,hand_id uuid,club_id uuid,rake_amount numeric,created_at timestamptz,is_tournament boolean,tournament_id uuid);
CREATE TABLE accounting_cash_bank_receipts(rake_record_id uuid PRIMARY KEY,union_id uuid,club_id uuid,union_transaction_id uuid UNIQUE,club_ledger_id uuid,banked_at timestamptz,amount numeric);
CREATE TABLE accounting_cash_accrual_batches(rake_record_id uuid PRIMARY KEY,earned_at timestamptz,status text);
CREATE TABLE accounting_cash_rake_sources(id uuid PRIMARY KEY,rake_record_id uuid,player_id uuid,club_id uuid,union_id uuid,coordinator_union_id uuid,earned_at timestamptz,rake_credit numeric,contract jsonb);
CREATE TABLE accounting_tournament_fee_sources(id uuid PRIMARY KEY,rake_record_id uuid,tournament_id uuid,player_id uuid,club_id uuid,union_id uuid,coordinator_union_id uuid,charged_at timestamptz,rake_credit numeric,contract jsonb,game_type text);
CREATE TABLE accounting_tournament_fee_recognitions(tournament_id uuid PRIMARY KEY,recognized_at timestamptz,status text,net_rake numeric,union_id uuid,union_wallet_transaction_id uuid UNIQUE,bank_journal_id uuid);
CREATE TABLE accounting_tournament_recognized_sources(source_id uuid PRIMARY KEY,tournament_id uuid,recognized_at timestamptz,disposition text,rake_credit numeric);
CREATE TABLE tournaments(id uuid PRIMARY KEY,tournament_type text);
CREATE TABLE ca_op_claims(op_id text,fn_name text,claimed_by uuid,result jsonb,finalized_at timestamptz,PRIMARY KEY(op_id,fn_name));
CREATE TABLE chip_transactions(id uuid PRIMARY KEY,club_id uuid,amount numeric,transaction_type text,notes text,metadata jsonb,balance_after numeric,created_at timestamptz);
ALTER TABLE chip_ledger ADD COLUMN performed_by uuid,ADD COLUMN from_label text,ADD COLUMN to_label text,ADD COLUMN description text,
 ADD COLUMN pre_from_balance numeric,ADD COLUMN post_from_balance numeric,ADD COLUMN pre_to_balance numeric,ADD COLUMN post_to_balance numeric,
 ADD COLUMN idempotency_key text UNIQUE,ADD COLUMN epoch_id uuid,ADD COLUMN actor_service text,ADD COLUMN db_role text,ADD COLUMN correlation_id uuid,
 ADD COLUMN hand_id uuid,ADD COLUMN tournament_id uuid,ADD COLUMN table_id uuid,ADD COLUMN chain_seq bigint,ADD COLUMN prev_hash text,ADD COLUMN row_hash text;
ALTER TABLE chip_ledger ADD CONSTRAINT chip_ledger_category_check CHECK(category IN('rakeback','treasury_transfer','commission','settlement','rake','adjustment')),
 ADD CONSTRAINT chip_ledger_from_type_check CHECK(from_type IN('union_wallet','union_bank','club_treasury','player_wallet','agent_wallet','settlement_suspense'));
CREATE SEQUENCE chip_ledger_chain_seq;
CREATE FUNCTION fn_ca_current_epoch() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
CREATE FUNCTION fn_ca_raise_drift_incident(p_source text,p_classification text,p_severity text,p_dedupe_key text,p_discrepancy numeric,p_expected numeric,p_actual numeric,p_layer text,p_entity_type text,p_entity_id uuid,p_club_id uuid,p_union_id uuid,p_table_id uuid,p_tournament_id uuid,p_hand_id uuid,p_settlement_id text,p_wallet_ids uuid[],p_transaction_ids uuid[],p_suspected_cause text,p_ledger_balanced boolean,p_metadata jsonb) RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
