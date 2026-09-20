CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULL::uuid$$;
CREATE TABLE public.clubs(id uuid PRIMARY KEY,total_rake numeric DEFAULT 0,updated_at timestamptz);
INSERT INTO public.clubs(id) VALUES(u(99));
ALTER TABLE chip_ledger ALTER COLUMN id SET DEFAULT gen_random_uuid(),
 ALTER COLUMN created_at SET DEFAULT transaction_timestamp(),
 ADD COLUMN performed_by uuid,ADD COLUMN tournament_id uuid,ADD COLUMN description text;
ALTER TABLE tournaments ADD COLUMN status text DEFAULT 'COMPLETING',ADD COLUMN name text DEFAULT 'fixture',ADD COLUMN current_players integer DEFAULT 3;
CREATE TABLE club_wallets(club_id uuid PRIMARY KEY,period_rake_collected numeric DEFAULT 0,lifetime_rake_collected numeric DEFAULT 0,updated_at timestamptz);
INSERT INTO club_wallets(club_id) VALUES(u(99));
CREATE TABLE tournament_rake_settlements(tournament_id uuid PRIMARY KEY,club_id uuid,union_id uuid,amount numeric,destination text,source text,settled_at timestamptz,attributed_at timestamptz,attributed_users int,attribution_error text);
CREATE TABLE fixture_tournament_fee_escrow(tournament_id uuid PRIMARY KEY,balance numeric NOT NULL);
CREATE TABLE fixture_banks(bank_kind text,bank_id uuid,balance numeric NOT NULL,PRIMARY KEY(bank_kind,bank_id));
INSERT INTO fixture_banks VALUES('union',u(90),0),('club',u(99),0);
CREATE FUNCTION fn_ca_lock_settlement_lane_global() RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION increment_union_wallet(p_union uuid,p_amount numeric,p_club uuid,p_notes text) RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE event uuid:=current_setting('app.ledger_counterparty_entity')::uuid;BEGIN
 UPDATE fixture_tournament_fee_escrow SET balance=balance-p_amount WHERE tournament_id=event AND balance>=p_amount;
 IF NOT FOUND THEN RAISE EXCEPTION 'fixture_fee_escrow_insufficient'; END IF;
 UPDATE fixture_banks SET balance=balance+p_amount WHERE bank_kind='union' AND bank_id=p_union;
 INSERT INTO union_wallet_transactions VALUES(gen_random_uuid(),p_union,p_club,'rake_wallet','credit','rake',p_amount,transaction_timestamp(),p_notes);
 RETURN jsonb_build_object('success',true);
END$$;
CREATE FUNCTION credit_club_rake_to_treasury(p_club uuid,p_amount numeric) RETURNS void LANGUAGE plpgsql AS $$DECLARE event uuid:=current_setting('app.ledger_counterparty_entity')::uuid;BEGIN
 UPDATE fixture_tournament_fee_escrow SET balance=balance-p_amount WHERE tournament_id=event AND balance>=p_amount;
 IF NOT FOUND THEN RAISE EXCEPTION 'fixture_fee_escrow_insufficient'; END IF;
 UPDATE fixture_banks SET balance=balance+p_amount WHERE bank_kind='club' AND bank_id=p_club;
 INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,club_id,category,amount,created_at) VALUES(gen_random_uuid(),'prize_liability',event,'club_treasury',p_club,p_club,'rake',p_amount,transaction_timestamp());
END$$;
CREATE FUNCTION fn_poker_diamond_tournament_settle_fee(p uuid,s text) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"amount":2}'::jsonb$$;
CREATE FUNCTION fn_poker_diamond_tournament_close_custody(p uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"closed":true,"still_held":0}'::jsonb$$;

-- Projection of the original settlement-row fee-out trigger. Union's existing
-- projected wallet function already consumes its custody above.
CREATE FUNCTION fixture_retire_tournament_fee() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.settled_at IS NOT NULL AND OLD.settled_at IS NULL AND NEW.destination LIKE 'chip_retirement:%' THEN
  UPDATE fixture_tournament_fee_escrow SET balance=balance-NEW.amount
   WHERE tournament_id=NEW.tournament_id AND balance>=NEW.amount;
  IF NOT FOUND THEN RAISE EXCEPTION 'fixture_fee_escrow_insufficient'; END IF;
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER fixture_retire_tournament_fee AFTER UPDATE ON tournament_rake_settlements
 FOR EACH ROW EXECUTE FUNCTION fixture_retire_tournament_fee();
