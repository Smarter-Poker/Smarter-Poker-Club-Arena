-- Local PostgreSQL rehearsal for the stage-one satellite authority. It copies
-- the installed function into pg_temp, supplies isolated evidence tables and
-- injects a source-table close refusal after the ticket, Bubble payment, rake
-- and escrow work. The caught error must leave every temp row at its exact
-- pre-call value. Removing the injection must then produce one exact closeout
-- whose full installed receipt replays byte-identically. No production row is
-- read or written.
DO $prepare$
DECLARE
  v_source text;
BEGIN
  IF to_regprocedure('public.fn_settle_satellite_tournament(uuid,uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'FAIL atomic satellite authority is not installed';
  END IF;
  SELECT pg_get_functiondef(
           'public.fn_settle_satellite_tournament(uuid,uuid)'::regprocedure)
    INTO v_source;
  IF position('UPDATE public.table_seats' IN v_source) = 0
     OR position('UPDATE public.tables' IN v_source) = 0
     OR position('public.fn_settle_tournament_rake(' IN v_source) = 0
     OR position('RETURN public.fn_ca_satellite_settlement_receipt' IN v_source) = 0
     OR position('UPDATE public.tables' IN v_source)
          < position('public.fn_settle_tournament_rake(' IN v_source) THEN
    RAISE EXCEPTION 'FAIL satellite closeout is not after the terminal money work';
  END IF;
END;
$prepare$;

CREATE TEMP TABLE tournaments AS
  SELECT * FROM public.tournaments WITH NO DATA;
CREATE TEMP TABLE tournament_players AS
  SELECT * FROM public.tournament_players WITH NO DATA;
CREATE TEMP TABLE tournament_escrow AS
  SELECT * FROM public.tournament_escrow WITH NO DATA;
CREATE TEMP TABLE tournament_obligations AS
  SELECT * FROM public.tournament_obligations WITH NO DATA;
CREATE TEMP TABLE tournament_payouts AS
  SELECT * FROM public.tournament_payouts WITH NO DATA;
CREATE TEMP TABLE wallet_credit_idempotency AS
  SELECT * FROM public.wallet_credit_idempotency WITH NO DATA;
CREATE TEMP TABLE chip_ledger AS
  SELECT * FROM public.chip_ledger WITH NO DATA;
CREATE TEMP TABLE rake_records AS
  SELECT * FROM public.rake_records WITH NO DATA;
CREATE TEMP TABLE tournament_rake_settlements AS
  SELECT * FROM public.tournament_rake_settlements WITH NO DATA;
CREATE TEMP TABLE managed_game_contract_versions AS
  SELECT * FROM public.managed_game_contract_versions WITH NO DATA;
CREATE TEMP TABLE tournament_satellite_settlements AS
  SELECT * FROM public.tournament_satellite_settlements WITH NO DATA;
CREATE TEMP TABLE tournament_satellite_awards AS
  SELECT * FROM public.tournament_satellite_awards WITH NO DATA;
CREATE TEMP TABLE tables AS
  SELECT * FROM public.tables WITH NO DATA;
CREATE TEMP TABLE table_seats AS
  SELECT * FROM public.table_seats WITH NO DATA;

ALTER TABLE pg_temp.tournament_players ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE pg_temp.tournament_obligations ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE pg_temp.tournament_payouts ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE pg_temp.chip_ledger ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE pg_temp.rake_records ALTER COLUMN id SET DEFAULT gen_random_uuid();

CREATE OR REPLACE FUNCTION pg_temp.fn_ca_escrow_apply(
  p_tournament_id uuid,
  p_what text,
  p_gross_in numeric DEFAULT 0,
  p_fee_entries_in numeric DEFAULT 0,
  p_satellite_fee_in numeric DEFAULT 0,
  p_bounty_in numeric DEFAULT 0,
  p_overlay_in numeric DEFAULT 0,
  p_satellite_in numeric DEFAULT 0,
  p_prize_out numeric DEFAULT 0,
  p_bounty_out numeric DEFAULT 0,
  p_fee_out numeric DEFAULT 0,
  p_refund numeric DEFAULT 0,
  p_reserve_out numeric DEFAULT 0,
  p_reserve_in numeric DEFAULT 0
)
RETURNS void LANGUAGE plpgsql AS $probe_helper$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_temp.tournament_escrow e
     WHERE e.tournament_id = p_tournament_id
  ) THEN
    RAISE EXCEPTION 'fixture lost escrow % during %', p_tournament_id, p_what;
  END IF;
END;
$probe_helper$;

CREATE OR REPLACE FUNCTION pg_temp.fn_credit_and_log(
  p_user_id uuid,
  p_amount numeric,
  p_idempotency_key text,
  p_category text,
  p_description text,
  p_related_entity_id uuid DEFAULT NULL,
  p_wallet_type text DEFAULT 'PLAYER',
  p_table_id uuid DEFAULT NULL,
  p_hand_id uuid DEFAULT NULL,
  p_payout_position integer DEFAULT NULL,
  p_payout_source text DEFAULT NULL
)
RETURNS boolean LANGUAGE plpgsql AS $probe_helper$
BEGIN
  INSERT INTO pg_temp.wallet_credit_idempotency(key,user_id,amount,created_at)
  VALUES(p_idempotency_key,p_user_id,p_amount,transaction_timestamp());
  INSERT INTO pg_temp.tournament_payouts(
    tournament_id,user_id,"position",amount,source,idempotency_key,paid_at,
    tournament_type,field_size,prize_pool,recorded_by)
  SELECT p_related_entity_id,p_user_id,p_payout_position,p_amount,p_payout_source,
         p_idempotency_key,transaction_timestamp(),t.tournament_type,
         (SELECT count(*) FROM pg_temp.tournament_players tp
           WHERE tp.tournament_id = p_related_entity_id),
         t.prize_pool,'probe.fn_credit_and_log'
    FROM pg_temp.tournaments t WHERE t.id = p_related_entity_id;
  RETURN true;
END;
$probe_helper$;

CREATE OR REPLACE FUNCTION pg_temp.fn_settle_tournament_rake(
  p_tournament_id uuid,
  p_source text DEFAULT 'engine'
)
RETURNS jsonb LANGUAGE plpgsql AS $probe_helper$
DECLARE
  v_amount numeric;
BEGIN
  SELECT round(COALESCE(sum(r.rake_amount),0),2) INTO v_amount
    FROM pg_temp.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;
  UPDATE pg_temp.tournament_escrow
     SET fee_out = fee_out + v_amount,
         fee_balance = fee_balance - v_amount
   WHERE tournament_id = p_tournament_id;
  INSERT INTO pg_temp.tournament_rake_settlements(
    tournament_id,amount,settled_at,attributed_at)
  VALUES(p_tournament_id,v_amount,transaction_timestamp(),transaction_timestamp());
  RETURN jsonb_build_object('ok',true,'amount',v_amount,'attributed',true,
                            'source',p_source);
END;
$probe_helper$;

CREATE OR REPLACE FUNCTION pg_temp.probe_payout_drains_source()
RETURNS trigger LANGUAGE plpgsql AS $probe_helper$
BEGIN
  UPDATE pg_temp.tournament_escrow
     SET prize_out = prize_out + NEW.amount,
         prize_balance = prize_balance - NEW.amount
   WHERE tournament_id = NEW.tournament_id;
  RETURN NULL;
END;
$probe_helper$;
CREATE TRIGGER probe_payout_drains_source
  AFTER INSERT ON pg_temp.tournament_payouts
  FOR EACH ROW EXECUTE FUNCTION pg_temp.probe_payout_drains_source();

CREATE OR REPLACE FUNCTION pg_temp.probe_target_pool_transfer()
RETURNS trigger LANGUAGE plpgsql AS $probe_helper$
BEGIN
  UPDATE pg_temp.tournament_escrow
     SET satellite_in = satellite_in + NEW.amount,
         prize_balance = prize_balance + NEW.amount
   WHERE tournament_id = NEW.to_entity_id;
  RETURN NULL;
END;
$probe_helper$;
CREATE TRIGGER probe_target_pool_transfer
  AFTER INSERT ON pg_temp.chip_ledger
  FOR EACH ROW EXECUTE FUNCTION pg_temp.probe_target_pool_transfer();

CREATE OR REPLACE FUNCTION pg_temp.probe_target_fee_reclassifies()
RETURNS trigger LANGUAGE plpgsql AS $probe_helper$
BEGIN
  IF NEW.source = 'fn_award_satellite_seat' THEN
    UPDATE pg_temp.tournament_escrow
       SET satellite_in = satellite_in - NEW.rake_amount,
           satellite_fee_in = satellite_fee_in + NEW.rake_amount,
           prize_balance = prize_balance - NEW.rake_amount,
           fee_balance = fee_balance + NEW.rake_amount
     WHERE tournament_id = NEW.tournament_id;
  END IF;
  RETURN NULL;
END;
$probe_helper$;
CREATE TRIGGER probe_target_fee_reclassifies
  AFTER INSERT ON pg_temp.rake_records
  FOR EACH ROW EXECUTE FUNCTION pg_temp.probe_target_fee_reclassifies();

DO $copy_authority$
DECLARE
  v_source text;
  v_receipt text;
  v_outcome text;
BEGIN
  SELECT pg_get_functiondef(
           'public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure)
    INTO v_receipt;
  v_receipt := replace(v_receipt,'public.','pg_temp.');
  EXECUTE v_receipt;

  SELECT pg_get_functiondef(
           'public.fn_settle_satellite_tournament(uuid,uuid)'::regprocedure)
    INTO v_source;
  v_source := replace(v_source,'public.','pg_temp.');
  EXECUTE v_source;

  SELECT pg_get_functiondef(
           'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)'::regprocedure)
    INTO v_outcome;
  v_outcome := replace(v_outcome,'public.','pg_temp.');
  EXECUTE v_outcome;
END;
$copy_authority$;

INSERT INTO pg_temp.tournaments(
  id,name,club_id,status,variant,tournament_type,satellite_target_id,
  satellite_target,satellite_seats,prize_pool,prize_pool_finalized,is_bounty,
  is_pko,is_mystery_bounty,is_premium_spin,buy_in_amount,buy_in_fee,
  max_players,current_players,current_level,late_reg_levels,rebuy_levels,
  total_rake,ended_at,on_break,break_ends_at,updated_at)
VALUES
  ('91000000-0000-4000-8000-000000000001','Closeout rollback satellite',
   '91000000-0000-4000-8000-000000000010','RUNNING','satellite','SATELLITE',
   '91000000-0000-4000-8000-000000000002',NULL,1,285,true,false,false,false,
   false,10,0,2,2,0,0,0,10,NULL,false,NULL,transaction_timestamp()),
  ('91000000-0000-4000-8000-000000000002','Open target',
   '91000000-0000-4000-8000-000000000010','REGISTERING','holdem','MTT',
   NULL,NULL,0,0,false,false,false,false,false,180,20,100,0,0,10,10,0,
   NULL,false,NULL,transaction_timestamp());

INSERT INTO pg_temp.tournament_escrow(
  tournament_id,enforced,gross_in,fee_entries_in,satellite_fee_in,bounty_in,
  overlay_in,satellite_in,prize_out,bounty_out,fee_out,refund_prize,
  refund_bounty,refund_fee,prize_balance,bounty_balance,fee_balance,reserve_out,
  reserve_in)
VALUES
  ('91000000-0000-4000-8000-000000000001',true,0,0,0,0,0,0,0,0,0,0,0,0,
   285,0,10,0,0),
  ('91000000-0000-4000-8000-000000000002',true,0,0,0,0,0,0,0,0,0,0,0,0,
   0,0,0,0,0);

INSERT INTO pg_temp.tournament_players(
  id,tournament_id,user_id,username,chips,status,position,prize,
  is_satellite_qualifier,source_satellite_id,elimination_sequence)
VALUES
  ('91000000-0000-4000-8000-000000000101',
   '91000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000201','Winner',100,'playing',NULL,0,
   NULL,NULL,NULL),
  ('91000000-0000-4000-8000-000000000102',
   '91000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000202','Bubble',0,'eliminated',NULL,0,
   NULL,NULL,1);

INSERT INTO pg_temp.tables(
  id,club_id,tournament_id,status,lifecycle,current_players,updated_at)
VALUES
  ('91000000-0000-4000-8000-000000000301',
   '91000000-0000-4000-8000-000000000010',
   '91000000-0000-4000-8000-000000000001','running','live',2,
   transaction_timestamp());
INSERT INTO pg_temp.table_seats(
  id,table_id,user_id,left_at,status,leave_pending,is_sitting_out)
VALUES
  ('91000000-0000-4000-8000-000000000401',
   '91000000-0000-4000-8000-000000000301',
   '91000000-0000-4000-8000-000000000201',NULL,'playing',false,false),
  ('91000000-0000-4000-8000-000000000402',
   '91000000-0000-4000-8000-000000000301',
   '91000000-0000-4000-8000-000000000202',NULL,'playing',false,false);
INSERT INTO pg_temp.rake_records(
  tournament_id,club_id,rake_amount,pot_size,num_players,bbj_contribution,
  is_tournament,source,metadata)
VALUES
  ('91000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000010',10,285,2,0,true,
   'probe.registration_fees','{}'::jsonb);

CREATE OR REPLACE FUNCTION pg_temp.refuse_satellite_table_close()
RETURNS trigger LANGUAGE plpgsql AS $fault$
BEGIN
  IF NEW.id = '91000000-0000-4000-8000-000000000301'::uuid
     AND lower(COALESCE(NEW.status::text,'')) = 'closed' THEN
    RAISE EXCEPTION 'injected source table close refusal' USING ERRCODE = 'XX001';
  END IF;
  RETURN NEW;
END;
$fault$;
CREATE TRIGGER refuse_satellite_table_close
  BEFORE UPDATE ON pg_temp.tables
  FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse_satellite_table_close();

DO $probe$
DECLARE
  v_caught boolean := false;
  v_before_outcome jsonb;
  v_after_outcome jsonb;
  v_first jsonb;
  v_replay jsonb;
BEGIN
  SELECT pg_temp.fn_resolve_satellite_settlement_outcome(
           '91000000-0000-4000-8000-000000000001',
           '91000000-0000-4000-8000-000000000201')
    INTO v_before_outcome;
  IF v_before_outcome->>'ok' IS DISTINCT FROM 'true'
     OR v_before_outcome->>'satellite_committed' IS DISTINCT FROM 'false'
     OR v_before_outcome->>'definitively_not_committed' IS DISTINCT FROM 'true'
     OR v_before_outcome->>'status' IS DISTINCT FROM 'RUNNING'
     OR v_before_outcome->'receipt' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION
      'FAIL serialized satellite outcome did not prove the pre-commit RUNNING miss: %',
      v_before_outcome;
  END IF;

  BEGIN
    PERFORM pg_temp.fn_settle_satellite_tournament(
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000201');
  EXCEPTION WHEN SQLSTATE 'XX001' THEN
    v_caught := true;
  END;

  IF NOT v_caught
     OR (SELECT status FROM pg_temp.tournaments
          WHERE id = '91000000-0000-4000-8000-000000000001') <> 'RUNNING'
     OR (SELECT prize_pool FROM pg_temp.tournaments
          WHERE id = '91000000-0000-4000-8000-000000000002') <> 0
     OR (SELECT total_rake FROM pg_temp.tournaments
          WHERE id = '91000000-0000-4000-8000-000000000002') <> 0
     OR (SELECT current_players FROM pg_temp.tournaments
          WHERE id = '91000000-0000-4000-8000-000000000002') <> 0
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_players
                 WHERE tournament_id = '91000000-0000-4000-8000-000000000002')
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_payouts)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_obligations)
     OR EXISTS (SELECT 1 FROM pg_temp.wallet_credit_idempotency)
     OR EXISTS (SELECT 1 FROM pg_temp.chip_ledger)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_rake_settlements)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_settlements)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_awards)
     OR (SELECT count(*) FROM pg_temp.rake_records) <> 1
     OR EXISTS (SELECT 1 FROM pg_temp.rake_records
                 WHERE source = 'fn_award_satellite_seat')
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tournament_escrow
        WHERE tournament_id = '91000000-0000-4000-8000-000000000001'
          AND prize_balance = 285 AND bounty_balance = 0 AND fee_balance = 10
          AND prize_out = 0 AND fee_out = 0)
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tournament_escrow
        WHERE tournament_id = '91000000-0000-4000-8000-000000000002'
          AND prize_balance = 0 AND bounty_balance = 0 AND fee_balance = 0
          AND satellite_in = 0 AND satellite_fee_in = 0)
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tables
        WHERE id = '91000000-0000-4000-8000-000000000301'
          AND lower(status::text) = 'running' AND lifecycle = 'live'
          AND current_players = 2)
     OR (SELECT count(*) FROM pg_temp.table_seats WHERE left_at IS NULL) <> 2
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tournament_players
        WHERE id = '91000000-0000-4000-8000-000000000101'
          AND status::text = 'playing' AND position IS NULL AND prize = 0)
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tournament_players
        WHERE id = '91000000-0000-4000-8000-000000000102'
          AND status::text = 'eliminated' AND position IS NULL AND prize = 0) THEN
    RAISE EXCEPTION
      'FAIL injected source close refusal left ticket, Bubble, rake, escrow, lifecycle, receipt, table, seat or standings state behind';
  END IF;

  DROP TRIGGER refuse_satellite_table_close ON pg_temp.tables;

  SELECT pg_temp.fn_settle_satellite_tournament(
           '91000000-0000-4000-8000-000000000001',
           '91000000-0000-4000-8000-000000000201')
    INTO v_first;
  SELECT pg_temp.fn_settle_satellite_tournament(
           '91000000-0000-4000-8000-000000000001',
           '91000000-0000-4000-8000-000000000201')
    INTO v_replay;
  SELECT pg_temp.fn_resolve_satellite_settlement_outcome(
           '91000000-0000-4000-8000-000000000001',
           '91000000-0000-4000-8000-000000000201')
    INTO v_after_outcome;

  IF v_replay IS DISTINCT FROM v_first
     OR v_after_outcome->>'ok' IS DISTINCT FROM 'true'
     OR v_after_outcome->>'satellite_committed' IS DISTINCT FROM 'true'
     OR v_after_outcome->>'definitively_not_committed' IS DISTINCT FROM 'false'
     OR v_after_outcome->>'status' IS DISTINCT FROM 'COMPLETED'
     OR v_after_outcome->'receipt' IS DISTINCT FROM v_first
     OR v_first->>'ok' IS DISTINCT FROM 'true'
     OR v_first->>'fully_settled' IS DISTINCT FROM 'true'
     OR v_first->>'status' IS DISTINCT FROM 'COMPLETED'
     OR (v_first->>'source_table_count')::integer <> 1
     OR (v_first->>'source_seat_count')::integer <> 2
     OR (v_first->>'released_seat_count')::integer <> 2
     OR v_first->'source_closeout'->'source_table_ids' IS DISTINCT FROM
          '["91000000-0000-4000-8000-000000000301"]'::jsonb
     OR v_first->'source_closeout'->'source_seat_ids' IS DISTINCT FROM
          '["91000000-0000-4000-8000-000000000401",
            "91000000-0000-4000-8000-000000000402"]'::jsonb
     OR v_first->'source_closeout'->'released_seat_ids' IS DISTINCT FROM
          '["91000000-0000-4000-8000-000000000401",
            "91000000-0000-4000-8000-000000000402"]'::jsonb
     OR v_first->'source_closeout'->>'closed_at'
          IS DISTINCT FROM v_first->>'settled_at'
     OR (SELECT status FROM pg_temp.tournaments
          WHERE id = '91000000-0000-4000-8000-000000000001') <> 'COMPLETED'
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tables
        WHERE id = '91000000-0000-4000-8000-000000000301'
          AND lower(status::text) = 'closed' AND lifecycle = 'closed'
          AND current_players = 0)
     OR (SELECT count(*) FROM pg_temp.table_seats
          WHERE status = 'left' AND left_at IS NOT NULL
            AND leave_pending IS FALSE AND is_sitting_out IS FALSE) <> 2
     OR EXISTS (
       SELECT 1
         FROM pg_temp.table_seats ts
         CROSS JOIN pg_temp.tournament_satellite_settlements h
        WHERE h.tournament_id = '91000000-0000-4000-8000-000000000001'
          AND ts.id = ANY(h.released_seat_ids)
          AND ts.left_at IS DISTINCT FROM h.settled_at)
     OR (SELECT count(*) FROM pg_temp.tournament_satellite_settlements) <> 1
     OR (SELECT count(*) FROM pg_temp.tournament_satellite_awards) <> 1
     OR (SELECT count(*) FROM pg_temp.tournament_payouts) <> 2
     OR (SELECT round(sum(amount),2) FROM pg_temp.tournament_payouts) <> 285.00
     OR (SELECT count(*) FROM pg_temp.tournament_rake_settlements) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tournament_escrow
        WHERE tournament_id = '91000000-0000-4000-8000-000000000001'
          AND prize_balance = 0 AND bounty_balance = 0 AND fee_balance = 0)
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tournament_escrow
        WHERE tournament_id = '91000000-0000-4000-8000-000000000002'
          AND prize_balance = 180 AND bounty_balance = 0 AND fee_balance = 20)
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tournament_players
        WHERE tournament_id = '91000000-0000-4000-8000-000000000001'
          AND user_id = '91000000-0000-4000-8000-000000000201'
          AND status::text = 'winner' AND position = 1 AND prize = 200)
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tournament_players
        WHERE tournament_id = '91000000-0000-4000-8000-000000000001'
          AND user_id = '91000000-0000-4000-8000-000000000202'
          AND status::text = 'eliminated' AND position = 2 AND prize = 85) THEN
    RAISE EXCEPTION
      'FAIL exact satellite closeout or immutable replay did not survive after removing the injected refusal: %',
      v_first;
  END IF;

  RAISE EXCEPTION
    'AUDIT_TEST_PASS: injected source-table close refusal rolled back the actual satellite authority ticket, Bubble cash, rake, escrow, lifecycle, receipt, source-table, source-seat and standings writes; the serialized resolver proved the RUNNING miss and exact committed receipt; removing the refusal produced one exact closeout and byte-identical replay';
END;
$probe$;
