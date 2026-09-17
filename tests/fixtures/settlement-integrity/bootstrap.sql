-- Funding and delivery dependencies are controlled here; the tested P&L writer
-- and weekly coordinator come directly from their guarded production migration.
ALTER TABLE settlement_periods ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE settlement_periods ADD COLUMN period_number int,ADD COLUMN year int,ADD COLUMN status text,
 ADD COLUMN total_player_winnings numeric,ADD COLUMN total_player_losses numeric,
 ADD COLUMN seated_stack_snapshot numeric,ADD COLUMN settled_at timestamptz,
 ADD COLUMN created_at timestamptz DEFAULT now();
CREATE UNIQUE INDEX settlement_periods_fixture_window ON settlement_periods(club_id,union_id,start_at,end_at);
ALTER TABLE settlement_invoices ADD COLUMN id uuid DEFAULT gen_random_uuid(),
 ADD COLUMN from_entity_type text,ADD COLUMN from_entity_id text,ADD COLUMN to_entity_type text,
 ADD COLUMN to_entity_id text,ADD COLUMN gross_amount numeric,ADD COLUMN net_amount numeric,
 ADD COLUMN deductions numeric,ADD COLUMN chips_transferred boolean,ADD COLUMN transferred_at timestamptz,
 ADD COLUMN notes text;
ALTER TABLE settlement_invoices ADD COLUMN source_ledger_id uuid UNIQUE;
CREATE TABLE chip_ledger(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),performed_by uuid,
 from_type text,from_entity_id uuid,from_label text,to_type text,to_entity_id uuid,to_label text,
 amount numeric,category text,club_id uuid,union_id uuid,description text,
 pre_from_balance numeric,post_from_balance numeric,pre_to_balance numeric,post_to_balance numeric,
 status text DEFAULT 'posted',settlement_id text DEFAULT NULLIF(current_setting('app.ledger_settlement',true),''));
-- Controlled central delivery dependency, invoked by the real treasury autoledger.
-- Its singleton source key and synchronous failure are the receipt contract under test.
CREATE FUNCTION test_pnl_central_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.category='pnl_settlement' THEN
  IF current_setting('test.pnl_missing_receipt',true)='true' THEN RETURN NEW; END IF;
  INSERT INTO settlement_invoices(club_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
   gross_amount,net_amount,deductions,chips_transferred,status,message_sent,source_ledger_id)
  VALUES(NEW.club_id,'transaction_receipt',CASE WHEN NEW.from_type='club_treasury' THEN 'club' ELSE 'union' END,
   NEW.from_entity_id::text,CASE WHEN NEW.to_type='club_treasury' THEN 'club' ELSE 'union' END,
   NEW.to_entity_id::text,NEW.amount,NEW.amount,0,true,'paid',true,NEW.id);
 END IF;
 RETURN NEW;END$$;
CREATE TRIGGER test_pnl_receipt AFTER INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION test_pnl_central_receipt();
CREATE TABLE union_wallets(union_id uuid PRIMARY KEY,chip_balance numeric);
CREATE TABLE union_pnl_settlements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),union_id uuid,period_start timestamptz,
 period_end timestamptz,status text,total_collected numeric DEFAULT 0,total_paid numeric DEFAULT 0,
 total_unpaid numeric DEFAULT 0,house_residual numeric,club_results jsonb,settled_at timestamptz);
CREATE UNIQUE INDEX ux_union_pnl_settlements_period ON union_pnl_settlements(union_id,period_start)
 WHERE status IN('in_progress','settled');
CREATE TABLE ca_settlements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),settlement_type text,external_ref text,
 state text,union_id uuid,idempotency_key text,error_detail text,totals jsonb,UNIQUE(settlement_type,external_ref));
CREATE TABLE union_wallet_transactions(union_id uuid,wallet text,direction text,amount numeric,balance_after numeric,
 tx_type text,club_id uuid,notes text);
CREATE TABLE chip_transactions(club_id uuid,amount numeric,transaction_type text,notes text,metadata jsonb);
CREATE TABLE pnl_incidents(source text,message text,context jsonb);
CREATE FUNCTION fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)
 RETURNS uuid LANGUAGE sql AS $$INSERT INTO pnl_incidents VALUES($1,$19,$21) RETURNING gen_random_uuid()$$;
CREATE TABLE pnl_input(club_id uuid PRIMARY KEY,net numeric,rake numeric DEFAULT 0,horse boolean DEFAULT false);
CREATE FUNCTION fn_union_pnl_baseline(uuid,timestamptz) RETURNS jsonb LANGUAGE sql AS $$SELECT '[]'::jsonb$$;
CREATE FUNCTION fn_union_pnl_all_clubs(uuid,timestamptz,timestamptz,boolean)
 RETURNS TABLE(club_id uuid,buyins numeric,cashouts numeric,realized_net numeric,winnings numeric,losses numeric,players int,seated_stack numeric)
 LANGUAGE plpgsql AS $$BEGIN
 IF NOT $4 THEN RAISE EXCEPTION 'horses may not be excluded'; END IF;
 RETURN QUERY SELECT p.club_id,100::numeric,100::numeric,p.net-p.rake,GREATEST(p.net,0),GREATEST(-p.net,0),1,0::numeric FROM pnl_input p;
 END$$;
CREATE FUNCTION fn_union_rake_paid_by_club(uuid,timestamptz,timestamptz,boolean)
 RETURNS TABLE(club_id uuid,rake_paid numeric) LANGUAGE plpgsql AS $$BEGIN
 IF NOT $4 THEN RAISE EXCEPTION 'horses may not be excluded from rake'; END IF;
 RETURN QUERY SELECT p.club_id,p.rake FROM pnl_input p; END$$;
CREATE FUNCTION fn_union_pnl_cash_by_club(uuid,timestamptz,timestamptz,boolean)
 RETURNS TABLE(club_id uuid,buyins numeric,cashouts numeric,realized_net numeric,players int,seated_stack numeric)
 LANGUAGE plpgsql AS $$BEGIN
 IF NOT $4 THEN RAISE EXCEPTION 'horses may not be excluded from cash'; END IF;
 RETURN QUERY SELECT p.club_id,100::numeric,100::numeric,p.net,1,0::numeric FROM pnl_input p; END$$;
CREATE TABLE pnl_delivery(invoice_id uuid);
CREATE FUNCTION test_pnl_delivery() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.source_ledger_id IS NOT NULL THEN
  IF current_setting('test.pnl_delivery_failure',true)='true' AND NEW.to_entity_type='club' THEN
   RAISE EXCEPTION 'pnl invoice notification failure'; END IF;
  INSERT INTO pnl_delivery VALUES(NEW.id);
 END IF;
 RETURN NEW;END$$;
CREATE TRIGGER test_pnl_invoice_delivery AFTER INSERT ON settlement_invoices FOR EACH ROW EXECUTE FUNCTION test_pnl_delivery();
INSERT INTO ca_money_rpc_registry VALUES('fn_union_settle_player_pnl','approved','fixture of existing registered writer');
