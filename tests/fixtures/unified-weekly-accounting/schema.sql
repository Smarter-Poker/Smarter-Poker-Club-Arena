ALTER TABLE clubs ADD COLUMN union_id uuid,ADD COLUMN is_union boolean DEFAULT false;
ALTER TABLE agents ADD COLUMN is_prepaid boolean DEFAULT true,ADD COLUMN credit_used numeric DEFAULT 0;
ALTER TABLE chip_ledger ADD COLUMN settlement_id text;
CREATE TABLE settlement_periods(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,union_id uuid,period_number int NOT NULL,year int NOT NULL,start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,
 status text CHECK(status IN('open','processing','settled','disputed','closed')),settled_at timestamptz,settled_by uuid,updated_at timestamptz,UNIQUE(club_id,union_id,start_at,end_at));
CREATE TABLE ca_settlements(id uuid PRIMARY KEY,settlement_type text,union_id uuid,state text,external_ref text,totals jsonb);
CREATE TABLE union_accounting_runs(union_id uuid NOT NULL,period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,scheduled_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN('running','complete','failed')),attempts int NOT NULL DEFAULT 0,started_at timestamptz,finished_at timestamptz,result jsonb NOT NULL DEFAULT '{}',PRIMARY KEY(union_id,period_start,period_end));
ALTER TABLE union_accounting_runs ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION ca_can_oversee_union(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT fn_is_union_overseer($1,auth.uid())$$;
CREATE POLICY union_accounting_runs_scoped_read ON union_accounting_runs FOR SELECT TO authenticated USING(ca_can_oversee_union(union_id));
CREATE TABLE financial_alerts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source text,severity text,message text,context jsonb);
CREATE TABLE daemon_state(daemon text PRIMARY KEY,high_water_mark timestamptz,high_water_mark_id uuid,updated_at timestamptz);
CREATE TABLE rake_records(id uuid PRIMARY KEY,club_id uuid,hand_id uuid,table_id uuid,tournament_id uuid,rake_amount numeric,is_tournament boolean,metadata jsonb,created_at timestamptz);
CREATE TABLE rake_attributions(rake_record_id uuid,club_id uuid);
CREATE TABLE accounting_cash_accrual_batches(rake_record_id uuid,status text);
CREATE TABLE accounting_cash_bank_receipts(rake_record_id uuid PRIMARY KEY,union_id uuid,club_id uuid,union_transaction_id uuid,club_ledger_id uuid,banked_at timestamptz,amount numeric);
CREATE TABLE accounting_agreement_history(id bigint,entity_key text,entity_type text,observed_at timestamptz,after_terms jsonb);
CREATE TABLE union_rake_rollup_days(union_id uuid,day date);
CREATE TABLE credit_invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),agent_id uuid,period_start timestamptz,period_end timestamptz,debt_owed numeric,amount_remaining numeric,status text,due_date timestamptz);
ALTER TABLE union_settlement_rounds ADD COLUMN round_name text,ADD COLUMN payers int,ADD COLUMN detail jsonb,ADD PRIMARY KEY(union_id,period_start,period_end,round_no);
INSERT INTO ca_money_rpc_registry(proname,status) VALUES('fn_club_weekly_accounting_summary','approved'),('fn_issue_club_weekly_accounting','approved'),('fn_process_weekly_accounting','approved');
CREATE UNIQUE INDEX accounting_one_club_weekly_statement ON settlement_invoices(club_id,period_id) WHERE invoice_type='club_weekly_accounting';
-- These controls are explicit fixture dependency seams. The production stage,
-- statement, coordinator and preparation verifier bodies are not substituted.
CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT COALESCE(current_setting('test.frozen',true),'false')::boolean$$;
CREATE FUNCTION fn_union_rake_rollup_refresh_day(uuid,date) RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION fn_union_eco_enabled(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_union_setting(uuid,text,numeric) RETURNS numeric LANGUAGE sql AS $$SELECT 1::numeric$$;
CREATE FUNCTION fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM ca_settlements WHERE union_id=$1 AND state='final') THEN RAISE EXCEPTION 'fixture_paid_round1_missing';END IF;
 RETURN jsonb_build_object('success',true,'already_executed',true,'total_rakeback',90,'clubs_paid',1,'period_rake',100,'union_retained',10);END$$;
CREATE FUNCTION fn_union_issue_weekly_invoices(uuid,timestamptz,timestamptz,boolean) RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE c record;n int:=0;BEGIN
 FOR c IN SELECT club_id FROM fn_accounting_week_clubs($1,NULL,$2,$3) LOOP
  IF NOT EXISTS(SELECT 1 FROM settlement_invoices WHERE invoice_type='union_weekly_squareup' AND club_id=c.club_id) THEN
   INSERT INTO settlement_invoices(club_id,period_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,gross_amount,net_amount,deductions,breakdown,status)
   SELECT c.club_id,sp.id,'union_weekly_squareup','union',$1::text,'club',c.club_id::text,0,0,0,jsonb_build_object('union_id',$1,'period_start',$2,'period_end',$3),'generated'
    FROM settlement_periods sp WHERE sp.club_id=c.club_id AND sp.union_id=$1 AND sp.start_at=$2 AND sp.end_at=$3;n:=n+1;
  END IF;
 END LOOP;RETURN jsonb_build_object('success',true,'invoices',n);END$$;
CREATE TABLE accounting_period_recompute_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,period_start date,period_end date,requested_at timestamptz,status text,last_result jsonb,attempts int,UNIQUE(club_id,period_start,period_end));
CREATE FUNCTION fn_rakeback_recompute_periods(uuid,date,date,uuid[]) RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE q record;r jsonb;blocked boolean;BEGIN
 blocked:=COALESCE(current_setting('test.preparation_blocked',true),'false')::boolean;
 INSERT INTO accounting_period_recompute_requests(club_id,period_start,period_end,requested_at,status,attempts)
  VALUES($1,$2,$3,clock_timestamp(),CASE WHEN blocked THEN 'blocked' ELSE 'complete' END,1)
  ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET attempts=accounting_period_recompute_requests.attempts+1,requested_at=clock_timestamp(),status=EXCLUDED.status RETURNING * INTO q;
 r:=jsonb_build_object('accounting_version',2,'club_id',$1,'period_start',$2,'period_end',$3,'status',CASE WHEN blocked THEN 'blocked' ELSE 'ready' END,'reason',CASE WHEN blocked THEN 'fixture_missing_source' END);
 UPDATE accounting_period_recompute_requests SET last_result=r WHERE id=q.id;
 RETURN r||jsonb_build_object('request_id',CASE WHEN COALESCE(current_setting('test.forged_request',true),'false')::boolean THEN gen_random_uuid() ELSE q.id END,
 'requested_at',q.requested_at,'request_state',q.status,'request_recorded',true);END$$;
CREATE FUNCTION test_weekly_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('test.weekly_failure',true)='true' AND NEW.title LIKE 'Weekly Club Statement%' THEN RAISE EXCEPTION 'fixture weekly notification failure';END IF;RETURN NEW;END$$;
CREATE TRIGGER test_weekly_fault BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION test_weekly_fault();
CREATE FUNCTION test_clock() RETURNS timestamptz LANGUAGE sql AS $$SELECT current_setting('test.clock')::timestamptz$$;

ALTER TABLE union_wallets ADD COLUMN chip_balance numeric,ADD COLUMN rake_wallet numeric;
