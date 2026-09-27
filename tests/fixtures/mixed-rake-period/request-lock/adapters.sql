-- Local-only missing production subsystem adapters. They record calls rather
-- than mint, move or pay funds. The actual recognizer, request wrapper, weekly
-- quality function and calculator run unchanged; this does not certify these
-- bank/commission/VIP adapters or production trigger execution.
ALTER TABLE accounting_tournament_fee_recognitions ADD COLUMN union_wallet_transaction_id uuid, ADD COLUMN bank_journal_id uuid;
CREATE TABLE tournaments(id uuid PRIMARY KEY,club_id uuid,union_id uuid,is_private boolean);
CREATE TABLE accounting_routed_settlement_runs(period_start timestamptz,period_end timestamptz,union_id uuid,standalone_club_id uuid);
CREATE TABLE fixture_financial_calls(kind text,identity uuid,player uuid,amount numeric);
CREATE FUNCTION fn_accounting_tournament_bank_proof(uuid,timestamptz,uuid,uuid,numeric,uuid,uuid) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM tournament_rake_settlements WHERE tournament_id=$1 AND settled_at=$2 AND club_id IS NOT DISTINCT FROM $3 AND union_id IS NOT DISTINCT FROM $4 AND amount=$5) THEN RAISE EXCEPTION 'fixture_bank_proof_missing'; END IF;
 INSERT INTO fixture_financial_calls VALUES('bank',$1,NULL,$5);
END$$;
CREATE FUNCTION fn_post_accounting_commission_source(uuid,text,timestamptz,jsonb) RETURNS int LANGUAGE plpgsql AS $$BEGIN INSERT INTO fixture_financial_calls VALUES('commission',$1,($4->>'player_id')::uuid,($4->>'rake_credit')::numeric); RETURN 1; END$$;
CREATE FUNCTION apply_rakeback_player_stats(uuid,uuid,uuid,numeric,numeric) RETURNS void LANGUAGE plpgsql AS $$BEGIN INSERT INTO fixture_financial_calls VALUES('stats',$1,$2,$5); END$$;
CREATE FUNCTION fn_award_vip_credit(uuid,numeric,text,uuid,text) RETURNS void LANGUAGE plpgsql AS $$BEGIN INSERT INTO fixture_financial_calls VALUES('vip',$4,$1,$2); END$$;
