\set ON_ERROR_STOP on
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;END IF;END$$;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
CREATE FUNCTION u(int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT ('00000000-0000-4000-8000-'||lpad($1::text,12,'0'))::uuid$$;
CREATE FUNCTION assert_true(boolean,text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF $1 IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',$2; END IF;RAISE NOTICE 'PASS: %',$2; END$$;
CREATE FUNCTION refuses(text,text) RETURNS boolean LANGUAGE plpgsql AS $$BEGIN EXECUTE $1;RETURN false;EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'caught %: %',SQLSTATE,SQLERRM;RETURN SQLERRM=$2;END$$;
CREATE FUNCTION fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS $$SELECT COALESCE(current_setting('test.is_engine',true),'true')::boolean$$;
CREATE FUNCTION fn_union_week_start(timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$SELECT date_trunc('week',$1 AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles'$$;
CREATE FUNCTION fn_lock_rakeback_payer_clubs(uuid[]) RETURNS void LANGUAGE plpgsql AS $$DECLARE c uuid;BEGIN FOR c IN SELECT DISTINCT x FROM unnest($1)x ORDER BY x LOOP PERFORM pg_advisory_xact_lock(hashtext('club-arena:rakeback-payer'),hashtext(c::text));END LOOP;END$$;
CREATE FUNCTION fn_accounting_agreement_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'immutable'; END$$;
CREATE FUNCTION fn_agent_commission_rollup_recompute(jsonb) RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE TABLE ca_money_rpc_registry(proname text PRIMARY KEY,status text,notes text);
INSERT INTO ca_money_rpc_registry(proname,status) VALUES('fn_settle_round2_club_to_agents','approved'),('fn_settle_round3_agents_to_players','approved');
CREATE TABLE settlement_locks(lock_type text,is_active boolean);
CREATE TABLE union_settlement_floor(union_id uuid,earliest_period_start timestamptz);
CREATE TABLE accounting_cash_accrual_cutover(singleton boolean,starts_at timestamptz);
CREATE TABLE unions(id uuid PRIMARY KEY);
CREATE TABLE union_clubs(union_id uuid,club_id uuid);
CREATE TABLE clubs(id uuid PRIMARY KEY,chip_treasury numeric);
CREATE TABLE club_members(id uuid DEFAULT gen_random_uuid(),club_id uuid,user_id uuid,chip_balance numeric,agent_id uuid,updated_at timestamptz,PRIMARY KEY(club_id,user_id));
CREATE TABLE agents(id uuid PRIMARY KEY,club_id uuid,user_id uuid,role text,parent_agent_id uuid,commission_rate numeric,status text);
CREATE TABLE accounting_cash_rake_sources(id uuid PRIMARY KEY,rake_record_id uuid,player_id uuid,club_id uuid,union_id uuid,coordinator_union_id uuid,earned_at timestamptz,rake_credit numeric,contract jsonb);
CREATE TABLE agent_commissions(id uuid DEFAULT gen_random_uuid(),club_id uuid,user_id uuid,amount numeric,commission_rate numeric,source_type text,source_id uuid,created_at timestamptz,settled_at timestamptz,UNIQUE(source_type,source_id,user_id));
CREATE TABLE agent_commission_settlements(id uuid DEFAULT gen_random_uuid(),club_id uuid,user_id uuid,union_id uuid,period_start timestamptz,period_end timestamptz,amount numeric,rows_count int,paid_at timestamptz,settlement_ref text,UNIQUE(club_id,user_id,period_start,period_end));
CREATE TABLE union_settlement_rounds(union_id uuid,period_start timestamptz,period_end timestamptz,round_no int,amount numeric,payees int,shortfalls int);
CREATE TABLE wallet_transactions(id uuid DEFAULT gen_random_uuid(),user_id uuid,wallet_type text,type text,amount numeric,category text,description text,balance_after numeric,related_entity_id uuid);
CREATE TABLE chip_ledger(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,performed_by uuid,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,amount numeric,category text,club_id uuid,union_id uuid,description text,idempotency_key text UNIQUE,metadata jsonb);
ALTER TABLE chip_ledger ADD COLUMN pre_from_balance numeric,ADD COLUMN post_from_balance numeric,ADD COLUMN pre_to_balance numeric,ADD COLUMN post_to_balance numeric;
CREATE TABLE settlement_invoices(id uuid DEFAULT gen_random_uuid(),source_ledger_id uuid UNIQUE REFERENCES chip_ledger(id),status text,chips_transferred boolean,message_sent boolean,gross_amount numeric,net_amount numeric,deductions numeric);
CREATE TABLE test_deliveries(ledger_id uuid,category text,routing_context text);
CREATE FUNCTION test_invoice() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('app.accounting_routing_context',true) IS DISTINCT FROM
  COALESCE(NEW.union_id::text,'club:'||NEW.club_id::text)||':'||(NEW.metadata->>'period_start')::timestamptz::text||':'||(NEW.metadata->>'period_end')::timestamptz::text
 THEN RAISE EXCEPTION 'routing context is not scoped to this ledger'; END IF;
 IF current_setting('test.delivery_failure',true)=NEW.category THEN RAISE EXCEPTION 'test invoice delivery failure'; END IF;
 IF current_setting('test.skip_receipt',true)='true' THEN RETURN NEW; END IF;
 INSERT INTO settlement_invoices(source_ledger_id,status,chips_transferred,message_sent,gross_amount,net_amount,deductions)
 VALUES(NEW.id,'paid',true,true,NEW.amount,NEW.amount,0);
 INSERT INTO test_deliveries VALUES(NEW.id,NEW.category,current_setting('app.accounting_routing_context',true));RETURN NEW;END$$;
CREATE TRIGGER test_accounting_invoice AFTER INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION test_invoice();
CREATE TABLE rakeback_periods(id uuid PRIMARY KEY,user_id uuid,club_id uuid,period_start date,period_end date,rake_generated numeric,rakeback_rate numeric,rakeback_amount numeric,status text,paid_at timestamptz,rakeback_earned numeric,total_rake_paid numeric);
CREATE TABLE accounting_rakeback_period_calculations(id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,period_id uuid,accounting_version int DEFAULT 2,source_fingerprint text,club_id uuid,player_id uuid,coordinator_union_id uuid,period_start date,period_end date,rake_generated numeric,rakeback_amount numeric,display_rate numeric,payer_kind text,payer_user_id uuid,source_allocations jsonb);
CREATE TABLE rakeback_period_payouts(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,rakeback_period_id uuid,club_id uuid,user_id uuid,user_rake_contribution numeric,rakeback_pct numeric,payout_amount numeric,status text,paid_at timestamptz,wallet_transaction_id uuid,UNIQUE(rakeback_period_id,user_id));
CREATE FUNCTION tier(integer,integer,integer,text,numeric,numeric) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('agent_id',u($1),'user_id',u($2),'role',$4,'amount',$5,'rate',$6,'agreement',jsonb_build_object('terms',jsonb_build_object('parent_agent_id',CASE WHEN $3 IS NULL THEN NULL ELSE u($3) END)))$$;
CREATE FUNCTION run2() RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN RETURN fn_settle_round2_club_to_agents(u(1),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z');END$$;
CREATE FUNCTION run3() RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN RETURN fn_settle_round3_agents_to_players(u(1),'2026-09-07T07:00:00Z','2026-09-14T07:00:00Z');END$$;
CREATE FUNCTION run_all() RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE a jsonb;b jsonb;BEGIN a:=run2();b:=run3();RETURN jsonb_build_object('r2',a,'r3',b);END$$;
-- Supabase can pregrant service access through defaults; the migration must revoke it explicitly.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
