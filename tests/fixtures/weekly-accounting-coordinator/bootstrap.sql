CREATE SCHEMA extensions;
CREATE FUNCTION u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
CREATE FUNCTION assert_true(boolean,text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF $1 IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',$2;END IF;RAISE NOTICE 'PASS: %',$2;END$$;
CREATE FUNCTION refuses(text,text) RETURNS boolean LANGUAGE plpgsql AS $$BEGIN EXECUTE $1;RETURN false;EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'caught: %',SQLERRM;RETURN SQLSTATE=$2;END$$;
CREATE TABLE clubs(id uuid PRIMARY KEY,owner_id uuid,chip_treasury numeric DEFAULT 1000);
CREATE TABLE agents(id uuid PRIMARY KEY,user_id uuid,club_id uuid,credit_used numeric,is_prepaid boolean DEFAULT false);
CREATE TABLE credit_invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),agent_id uuid,period_start timestamptz,period_end timestamptz,debt_owed numeric,amount_paid numeric,amount_remaining numeric,status text,due_date timestamptz,UNIQUE(agent_id,period_end));
ALTER TABLE settlement_invoices ADD COLUMN period_id uuid;
CREATE TABLE settlement_periods(id uuid PRIMARY KEY,club_id uuid,union_id uuid,start_at timestamptz,end_at timestamptz);
CREATE TABLE daemon_state(daemon text PRIMARY KEY,high_water_mark timestamptz,updated_at timestamptz,high_water_mark_id uuid);
CREATE TABLE rake_records(id uuid,club_id uuid,rake_amount numeric,created_at timestamptz,is_tournament boolean,tournament_id uuid);
ALTER TABLE rakeback_periods ADD COLUMN id uuid DEFAULT gen_random_uuid(),ADD COLUMN rakeback_earned numeric,ADD COLUMN deferred_reason text,ADD COLUMN deferred_at timestamptz,ADD COLUMN defer_count int DEFAULT 0;
CREATE TABLE rakeback_daily_state(club_id uuid,day date);
CREATE FUNCTION fn_is_club_admin_uid(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_rakeback_recompute_day(uuid,date,boolean) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;
CREATE FUNCTION fn_close_settlement_period(uuid) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
 INSERT INTO effects VALUES(7,20);UPDATE rakeback_periods SET status='paid' WHERE id=$1;
 RETURN jsonb_build_object('success',true,'payout',20);
END$$;
CREATE FUNCTION fn_issue_club_weekly_accounting(uuid,timestamptz,timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('test.summary_failure',true)='true' THEN RAISE EXCEPTION 'summary delivery failed'; END IF;
 INSERT INTO effects VALUES(6,0);
 INSERT INTO settlement_invoices(club_id,period_id,invoice_type,message_sent,status) SELECT club_id,id,'club_weekly_accounting',true,'generated' FROM settlement_periods WHERE union_id=$1 AND start_at=$2 AND end_at=$3;
 RETURN jsonb_build_object('success',true,'issued',1);
END$$;
CREATE FUNCTION test_invoice_delivery() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('test.credit_failure',true)='true' AND NEW.agent_id=u(33) THEN RAISE EXCEPTION 'invoice notification failed'; END IF;
 INSERT INTO effects VALUES(8,NEW.debt_owed);RETURN NEW;
END$$;
CREATE TRIGGER test_delivery AFTER INSERT ON credit_invoices FOR EACH ROW EXECUTE FUNCTION test_invoice_delivery();
CREATE FUNCTION fn_deliver_accounting_invoice(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;
CREATE FUNCTION fn_invoice_accounting_ledger_transfer(uuid) RETURNS uuid LANGUAGE sql AS $$SELECT $1$$;
