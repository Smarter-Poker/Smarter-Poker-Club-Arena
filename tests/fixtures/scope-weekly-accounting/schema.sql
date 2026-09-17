ALTER TABLE clubs ADD COLUMN union_id uuid,ADD COLUMN is_union boolean DEFAULT false;
ALTER TABLE settlement_periods ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE union_accounting_runs ADD COLUMN standalone_club_id uuid;
CREATE TABLE accounting_cash_accrual_cutover(singleton boolean,starts_at timestamptz);
INSERT INTO accounting_cash_accrual_cutover VALUES(true,'2026-09-07 07:00Z');
CREATE TABLE rake_records(id uuid PRIMARY KEY,club_id uuid,hand_id uuid,table_id uuid,tournament_id uuid,rake_amount numeric,is_tournament boolean,metadata jsonb,created_at timestamptz);
CREATE TABLE accounting_cash_rake_sources(id uuid PRIMARY KEY,rake_record_id uuid,player_id uuid,club_id uuid,union_id uuid,coordinator_union_id uuid,earned_at timestamptz,rake_credit numeric,contract jsonb);
CREATE TABLE accounting_cash_bank_receipts(rake_record_id uuid PRIMARY KEY,union_id uuid,club_id uuid,union_transaction_id uuid,club_ledger_id uuid,banked_at timestamptz,amount numeric);
CREATE TABLE accounting_rakeback_period_calculations(id bigint,club_id uuid,coordinator_union_id uuid,period_start date,period_end date);
CREATE TABLE accounting_routed_settlement_runs(scope_kind text,scope_id uuid,period_start timestamptz,period_end timestamptz,round_no int,result jsonb,PRIMARY KEY(scope_kind,scope_id,period_start,period_end,round_no));
CREATE FUNCTION fn_union_week_start(timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$SELECT date_trunc('week',$1 AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles'$$;

CREATE TABLE accounting_agreement_history(id bigint,entity_key text,entity_type text,observed_at timestamptz,after_terms jsonb);
ALTER TABLE settlement_periods ADD COLUMN period_number int,ADD COLUMN year int,ADD COLUMN settled_at timestamptz,ADD COLUMN settled_by uuid,ADD COLUMN updated_at timestamptz;
