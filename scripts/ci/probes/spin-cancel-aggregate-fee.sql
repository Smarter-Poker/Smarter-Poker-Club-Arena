DO $probe$
DECLARE src text; result jsonb; caught boolean;
event uuid:='00000000-0000-4000-8000-000000000001';
club uuid:='00000000-0000-4000-8000-000000000002';
BEGIN
CREATE TEMP TABLE tournaments(id uuid,club_id uuid,name text,variant text,status text,ended_at timestamptz,updated_at timestamptz,prize_pool numeric,bounty_pool numeric,total_rake numeric) ON COMMIT DROP;
CREATE TEMP TABLE tournament_players(id uuid,user_id uuid,tournament_id uuid,is_satellite_qualifier boolean,source_satellite_id uuid,status text,eliminated_at timestamptz,prize numeric) ON COMMIT DROP;
CREATE TEMP TABLE wallet_transactions(user_id uuid,related_entity_id uuid,type text,category text,amount numeric) ON COMMIT DROP;
CREATE TEMP TABLE chip_ledger(to_entity_id uuid,to_type text,idempotency_key text,amount numeric) ON COMMIT DROP;
CREATE TEMP TABLE rake_records(id uuid DEFAULT gen_random_uuid(),player_contributions jsonb,hand_id uuid,table_id uuid,club_id uuid,rake_amount numeric,pot_size numeric,num_players integer,bbj_contribution numeric,is_tournament boolean,tournament_id uuid,source text,metadata jsonb) ON COMMIT DROP;
CREATE TEMP TABLE tables(tournament_id uuid,status text,current_players integer) ON COMMIT DROP;
CREATE TEMP TABLE tournament_obligations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tournament_id uuid,kind text,place integer,user_id uuid,amount_owed numeric,amount_paid numeric,settled_at timestamptz) ON COMMIT DROP;
CREATE TEMP TABLE wallet_credit_idempotency(key text PRIMARY KEY,user_id uuid,amount numeric) ON COMMIT DROP;
CREATE TEMP TABLE tournament_cancellation_receipts(tournament_id uuid PRIMARY KEY,actor_id uuid,receipt_version integer,refunded_count integer,total_refunded numeric,fees_reversed numeric,player_count integer,table_count integer,receipt jsonb,settled_at timestamptz) ON COMMIT DROP;
EXECUTE $copy$CREATE FUNCTION pg_temp.probe_uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'$copy$;
EXECUTE $copy$CREATE FUNCTION pg_temp.is_club_admin(uuid,uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true'$copy$;
EXECUTE $copy$CREATE FUNCTION pg_temp.fn_settle_tournament_obligation(p_tid uuid,p_kind text,p_place integer,p_uid uuid,p_gross numeric,p_source text,p_description text) RETURNS jsonb LANGUAGE plpgsql AS $body$
DECLARE paid numeric; net numeric; obligation_id uuid; credit_key text;
BEGIN
SELECT o.id,o.amount_paid INTO obligation_id,paid FROM pg_temp.tournament_obligations o WHERE o.tournament_id=p_tid AND o.kind=p_kind AND o.place IS NOT DISTINCT FROM p_place AND o.user_id=p_uid FOR UPDATE;
IF obligation_id IS NULL THEN INSERT INTO pg_temp.tournament_obligations(tournament_id,kind,place,user_id,amount_owed,amount_paid) VALUES(p_tid,p_kind,p_place,p_uid,p_gross,0) RETURNING id,amount_paid INTO obligation_id,paid; END IF;
net:=greatest(0,p_gross-paid);
IF net>0 THEN
  credit_key:='tourney:'||p_tid::text||':obl:'||obligation_id::text||':'||(round(paid*100))::bigint::text;
  INSERT INTO pg_temp.wallet_transactions VALUES(p_uid,p_tid,'credit','refund',net);
  INSERT INTO pg_temp.wallet_credit_idempotency VALUES(credit_key,p_uid,net);
  UPDATE pg_temp.tournament_obligations SET amount_paid=p_gross,settled_at=now() WHERE id=obligation_id;
END IF;
RETURN jsonb_build_object('ok',true,'paid',net,'already_paid',paid,'amount_paid',p_gross,'remaining',0,'fully_settled',true,'obligation_id',obligation_id,'idempotency_key',credit_key);
END $body$ $copy$;
SELECT pg_get_functiondef('public.atomic_cancel_tournament(uuid,uuid)'::regprocedure) INTO src; EXECUTE replace(replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp'''),'auth.uid()','pg_temp.probe_uid()');
INSERT INTO pg_temp.tournaments VALUES(event,club,'test Spin','spin','REGISTERING',NULL,now(),8,0,0.48);
INSERT INTO pg_temp.tournament_players
SELECT gen_random_uuid(),('00000000-0000-4000-8000-00000000000'||n)::uuid,event,false,NULL,'registered',NULL,0 FROM generate_series(3,5)n;
INSERT INTO pg_temp.wallet_transactions SELECT user_id,event,'debit','tournament_buyin',2 FROM pg_temp.tournament_players;
INSERT INTO pg_temp.rake_records(hand_id,table_id,club_id,rake_amount,pot_size,num_players,bbj_contribution,is_tournament,tournament_id,source,metadata) VALUES(NULL,NULL,club,0.48,6,3,0,true,event,'fn_spin_book_entry','{"kind":"spin_rake"}');
UPDATE pg_temp.rake_records SET player_contributions='{"player-a":2,"player-b":2,"player-c":2}';
INSERT INTO pg_temp.tables VALUES(event,'waiting',3);
result:=pg_temp.atomic_cancel_tournament(event,NULL);
IF (SELECT sum(rake_amount) FROM pg_temp.rake_records)<>0 OR (result->>'fees_reversed')::numeric<>0.48 OR (SELECT total_rake FROM pg_temp.tournaments)<>0 THEN RAISE EXCEPTION 'FAIL aggregate Spin fee survives full cancellation'; END IF;
IF (SELECT sum(amount) FROM pg_temp.wallet_transactions WHERE type='credit')<>6 THEN RAISE EXCEPTION 'FAIL cancellation refunds changed'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_temp.rake_records reversal JOIN pg_temp.rake_records original ON reversal.metadata->>'original_rake_record_id'=original.id::text WHERE reversal.source='atomic_cancel_tournament' AND reversal.player_contributions=original.player_contributions AND reversal.player_contributions IS NOT NULL) THEN RAISE EXCEPTION 'FAIL fee reversal lost original player attribution'; END IF;
-- A duplicate cancellation replays the one immutable receipt without changing money.
result:=pg_temp.atomic_cancel_tournament(event,NULL);
IF NOT COALESCE((result->>'fully_settled')::boolean,false) OR (SELECT count(*) FROM pg_temp.tournament_cancellation_receipts)<>1 OR (SELECT sum(amount) FROM pg_temp.wallet_transactions WHERE type='credit')<>6 OR (SELECT sum(rake_amount) FROM pg_temp.rake_records)<>0 THEN RAISE EXCEPTION 'FAIL duplicate cancellation changed money or failed exact replay'; END IF;
-- A partially reversed aggregate fee contributes only its remaining attribution.
DELETE FROM pg_temp.tournament_cancellation_receipts;
UPDATE pg_temp.tournaments SET status='REGISTERING',total_rake=0.28,ended_at=NULL;
UPDATE pg_temp.tournament_players SET status='registered',eliminated_at=NULL;
UPDATE pg_temp.tables SET status='waiting',current_players=3;
UPDATE pg_temp.rake_records SET rake_amount=-0.2 WHERE source='atomic_cancel_tournament';
result:=pg_temp.atomic_cancel_tournament(event,NULL);
IF (SELECT sum(rake_amount) FROM pg_temp.rake_records)<>0 OR (result->>'fees_reversed')::numeric<>0.28 OR (SELECT sum(amount) FROM pg_temp.wallet_transactions WHERE type='credit')<>6 THEN RAISE EXCEPTION 'FAIL prior aggregate reversal not respected'; END IF;
-- A reversal insert failure must undo the entire original cancellation and refunds.
DELETE FROM pg_temp.rake_records WHERE source='atomic_cancel_tournament';
DELETE FROM pg_temp.wallet_transactions WHERE type='credit';
DELETE FROM pg_temp.wallet_credit_idempotency;
DELETE FROM pg_temp.tournament_obligations;
DELETE FROM pg_temp.tournament_cancellation_receipts;
UPDATE pg_temp.tournaments SET status='REGISTERING',total_rake=0.48,ended_at=NULL;
UPDATE pg_temp.tournament_players SET status='registered',eliminated_at=NULL;
UPDATE pg_temp.tables SET status='waiting',current_players=3;
EXECUTE $copy$CREATE FUNCTION pg_temp.refuse_fee_reversal() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN IF NEW.rake_amount<0 THEN RAISE EXCEPTION 'injected reversal refusal' USING ERRCODE='XX001'; END IF; RETURN NEW; END
$body$ $copy$;
CREATE TRIGGER refuse_fee BEFORE INSERT ON pg_temp.rake_records FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse_fee_reversal();
caught:=false;
BEGIN PERFORM pg_temp.atomic_cancel_tournament(event,NULL); EXCEPTION WHEN SQLSTATE 'XX001' THEN caught:=true; END;
IF NOT caught OR EXISTS(SELECT 1 FROM pg_temp.wallet_transactions WHERE type='credit') OR (SELECT status FROM pg_temp.tournaments)<>'REGISTERING' OR EXISTS(SELECT 1 FROM pg_temp.tournament_players WHERE status<>'registered') THEN RAISE EXCEPTION 'FAIL fee reversal failure committed refunds or cancellation'; END IF;
RAISE EXCEPTION 'AUDIT_TEST_PASS: actual cancellation reverses aggregate Spin fee once, preserves refunds, accounts for prior reversal and rolls back refunds/status on reversal failure; all rolled back';
END $probe$;
