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
          'public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid)')
          IS NULL
     OR to_regprocedure(
          'public.fn_tournament_late_registration_open(uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'FAIL atomic satellite authority is not installed';
  END IF;
  SELECT pg_get_functiondef(
           'public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid)'
             ::regprocedure)
    INTO v_source;
  IF position('UPDATE public.table_seats' IN v_source) = 0
     OR position('UPDATE public.tables' IN v_source) = 0
     OR position('public.fn_settle_tournament_rake(' IN v_source) = 0
     OR position(
          'public.fn_tournament_late_registration_open(v_target_id)'
          IN v_source) = 0
     OR position('NULLIF(v_target.late_reg_levels, 0)' IN v_source) <> 0
     OR position('v_target.late_reg_levels IS NULL' IN v_source) <> 0
     OR position('v_target.rebuy_levels IS NULL' IN v_source) <> 0
     OR position('v_target.current_level IS NULL' IN v_source) <> 0
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
CREATE TEMP TABLE tournament_satellite_settlements AS
  SELECT * FROM public.tournament_satellite_settlements WITH NO DATA;
CREATE TEMP TABLE tournament_satellite_awards AS
  SELECT * FROM public.tournament_satellite_awards WITH NO DATA;
CREATE TEMP TABLE tournament_satellite_remainders AS
  SELECT * FROM public.tournament_satellite_remainders WITH NO DATA;
CREATE TEMP TABLE tables AS
  SELECT * FROM public.tables WITH NO DATA;
CREATE TEMP TABLE table_seats AS
  SELECT * FROM public.table_seats WITH NO DATA;
CREATE TEMP TABLE elimination_witness_probe (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status text NOT NULL,
  elimination_sequence bigint
);
CREATE TEMP SEQUENCE tournament_player_elimination_sequence START 1;

ALTER TABLE pg_temp.tournament_players ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE pg_temp.tournament_obligations ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE pg_temp.tournament_payouts ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE pg_temp.chip_ledger ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE pg_temp.rake_records ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE pg_temp.tournament_satellite_settlements
  ALTER COLUMN receipt_version SET DEFAULT 2;
ALTER TABLE pg_temp.tournament_satellite_awards
  ALTER COLUMN created_at SET DEFAULT transaction_timestamp();
ALTER TABLE pg_temp.tournament_satellite_remainders
  ALTER COLUMN created_at SET DEFAULT transaction_timestamp();

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

CREATE OR REPLACE FUNCTION pg_temp.probe_close_stamps_escrow()
RETURNS trigger LANGUAGE plpgsql AS $probe_helper$
BEGIN
  IF NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED' THEN
    UPDATE pg_temp.tournament_escrow
       SET closed_at = transaction_timestamp(), close_note = 'closed at zero'
     WHERE tournament_id = NEW.id
       AND closed_at IS NULL;
  END IF;
  RETURN NULL;
END;
$probe_helper$;
CREATE TRIGGER probe_close_stamps_escrow
  AFTER UPDATE OF status ON pg_temp.tournaments
  FOR EACH ROW EXECUTE FUNCTION pg_temp.probe_close_stamps_escrow();

CREATE OR REPLACE FUNCTION pg_temp.probe_stamp_table_terminal_marker()
RETURNS trigger LANGUAGE plpgsql AS $probe_helper$
DECLARE
  v_status text;
  v_ended_at timestamptz;
BEGIN
  SELECT upper(COALESCE(t.status::text,'')),t.ended_at
    INTO v_status,v_ended_at
    FROM pg_temp.tournaments t WHERE t.id = NEW.tournament_id;
  IF v_status = 'COMPLETED' AND COALESCE(NEW.current_players,0) = 0 THEN
    NEW.status := 'closed';
    NEW.lifecycle := 'closed';
    NEW.terminal_closed_at := v_ended_at;
  END IF;
  RETURN NEW;
END;
$probe_helper$;
CREATE TRIGGER probe_stamp_table_terminal_marker
  BEFORE UPDATE OF status,lifecycle,current_players ON pg_temp.tables
  FOR EACH ROW EXECUTE FUNCTION pg_temp.probe_stamp_table_terminal_marker();

DO $copy_authority$
DECLARE
  v_source text;
  v_receipt text;
  v_outcome text;
  v_elimination text;
  v_contract_guard text;
  v_late_registration text;
BEGIN
  SELECT pg_get_functiondef(
           'public.fn_stamp_tournament_elimination_sequence()'::regprocedure)
    INTO v_elimination;
  v_elimination := replace(v_elimination,'public.','pg_temp.');
  EXECUTE v_elimination;

  SELECT pg_get_functiondef(
           'public.fn_satellite_target_contract_is_immutable()'::regprocedure)
    INTO v_contract_guard;
  v_contract_guard := replace(v_contract_guard,'public.','pg_temp.');
  EXECUTE v_contract_guard;
  EXECUTE $trigger$
    CREATE TRIGGER satellite_target_contract_is_immutable
      BEFORE UPDATE OF buy_in_amount,buy_in_fee,bounty_amount,rebuy_cost,addon_cost,
        is_bounty,is_pko,is_mystery_bounty,is_premium_spin,
        variant,tournament_type,club_id,entry_contract_locked
      ON pg_temp.tournaments
      FOR EACH ROW EXECUTE FUNCTION
        pg_temp.fn_satellite_target_contract_is_immutable()
  $trigger$;

  -- Copy the installed canonical predicate rather than reimplementing its
  -- levels-versus-minutes precedence in this rehearsal.
  SELECT pg_get_functiondef(
           'public.fn_tournament_late_registration_open(uuid)'::regprocedure)
    INTO v_late_registration;
  v_late_registration := replace(
    v_late_registration,'public.','pg_temp.');
  EXECUTE v_late_registration;

  SELECT pg_get_functiondef(
           'public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure)
    INTO v_receipt;
  v_receipt := replace(v_receipt,'public.','pg_temp.');
  EXECUTE v_receipt;

  SELECT pg_get_functiondef(
           'public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid)'
             ::regprocedure)
    INTO v_source;
  v_source := replace(
    v_source,
    'fn_settle_satellite_tournament_pre_seat_guard',
    'fn_settle_satellite_tournament');
  v_source := replace(v_source,'public.','pg_temp.');
  EXECUTE v_source;

  SELECT pg_get_functiondef(
           'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)'::regprocedure)
    INTO v_outcome;
  v_outcome := replace(v_outcome,'public.','pg_temp.');
  EXECUTE v_outcome;
END;
$copy_authority$;

CREATE TRIGGER probe_elimination_witness_owner
  BEFORE INSERT OR UPDATE OF status,elimination_sequence
  ON pg_temp.elimination_witness_probe
  FOR EACH ROW EXECUTE FUNCTION pg_temp.fn_stamp_tournament_elimination_sequence();

DO $elimination_witness_lifecycle$
DECLARE
  v_id integer;
  v_sequence bigint;
  v_mutation_refused boolean := false;
BEGIN
  INSERT INTO pg_temp.elimination_witness_probe(status,elimination_sequence)
  VALUES('playing',999) RETURNING id INTO v_id;
  IF (SELECT elimination_sequence FROM pg_temp.elimination_witness_probe
       WHERE id=v_id) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a live player retained a caller-supplied elimination witness';
  END IF;
  UPDATE pg_temp.elimination_witness_probe SET status='eliminated' WHERE id=v_id;
  SELECT elimination_sequence INTO v_sequence
    FROM pg_temp.elimination_witness_probe WHERE id=v_id;
  IF v_sequence IS NULL OR v_sequence <= 0 THEN
    RAISE EXCEPTION 'FAIL entering eliminated did not receive a positive witness';
  END IF;
  BEGIN
    UPDATE pg_temp.elimination_witness_probe
       SET elimination_sequence=v_sequence + 100 WHERE id=v_id;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_mutation_refused := true;
  END;
  IF NOT v_mutation_refused
     OR (SELECT elimination_sequence FROM pg_temp.elimination_witness_probe
          WHERE id=v_id) IS DISTINCT FROM v_sequence THEN
    RAISE EXCEPTION 'FAIL an eliminated witness accepted a caller rewrite';
  END IF;
  UPDATE pg_temp.elimination_witness_probe SET status='playing' WHERE id=v_id;
  IF (SELECT elimination_sequence FROM pg_temp.elimination_witness_probe
       WHERE id=v_id) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL rebuy revival retained a stale elimination witness';
  END IF;
  UPDATE pg_temp.elimination_witness_probe SET status='eliminated' WHERE id=v_id;
  UPDATE pg_temp.elimination_witness_probe
     SET status='winner',elimination_sequence=NULL WHERE id=v_id;
  IF (SELECT elimination_sequence FROM pg_temp.elimination_witness_probe
       WHERE id=v_id) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL all-busted promotion retained an elimination witness';
  END IF;
END;
$elimination_witness_lifecycle$;

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
   '91000000-0000-4000-8000-000000000010','RUNNING','holdem','MTT',
   NULL,NULL,0,360,false,false,false,false,false,180,20,100,2,1,10,10,40,
   NULL,false,NULL,transaction_timestamp());

INSERT INTO pg_temp.tournament_escrow(
  tournament_id,enforced,gross_in,fee_entries_in,satellite_fee_in,bounty_in,
  overlay_in,satellite_in,prize_out,bounty_out,fee_out,refund_prize,
  refund_bounty,refund_fee,prize_balance,bounty_balance,fee_balance,reserve_out,
  reserve_in)
VALUES
  ('91000000-0000-4000-8000-000000000001',true,0,0,0,0,0,0,0,0,0,0,0,0,
   285,0,10,0,0),
  ('91000000-0000-4000-8000-000000000002',true,400,40,0,0,0,0,0,0,0,0,0,0,
   360,0,40,0,0);

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
   NULL,NULL,1),
  ('91000000-0000-4000-8000-000000000110',
   '91000000-0000-4000-8000-000000000002',
   '91000000-0000-4000-8000-000000000210','Historical',0,'eliminated',9,0,
   false,NULL,1),
  ('91000000-0000-4000-8000-000000000111',
   '91000000-0000-4000-8000-000000000002',
   '91000000-0000-4000-8000-000000000211','Live',100,'playing',NULL,0,
   false,NULL,NULL);

INSERT INTO pg_temp.tables(
  id,club_id,tournament_id,status,lifecycle,current_players,updated_at)
VALUES
  ('91000000-0000-4000-8000-000000000301',
   '91000000-0000-4000-8000-000000000010',
   '91000000-0000-4000-8000-000000000001','running','live',2,
   transaction_timestamp());
INSERT INTO pg_temp.table_seats(
  id,table_id,user_id,left_at,status,leave_pending,is_sitting_out,is_away,
  sit_out_at,scheduled_leave_hands)
VALUES
  ('91000000-0000-4000-8000-000000000401',
   '91000000-0000-4000-8000-000000000301',
   '91000000-0000-4000-8000-000000000201',NULL,'playing',false,false,false,
   NULL,NULL),
  ('91000000-0000-4000-8000-000000000402',
   '91000000-0000-4000-8000-000000000301',
   '91000000-0000-4000-8000-000000000202',
   '2026-09-08 10:00:00+00'::timestamptz,'active',true,true,true,
   '2026-09-08 09:59:00+00'::timestamptz,2);
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

CREATE OR REPLACE FUNCTION pg_temp.assert_base_satellite_unsettled(
  p_context text
)
RETURNS void LANGUAGE plpgsql AS $probe_helper$
BEGIN
  IF (SELECT status FROM pg_temp.tournaments
       WHERE id = '91000000-0000-4000-8000-000000000001')
         IS DISTINCT FROM 'RUNNING'
     OR (SELECT current_players FROM pg_temp.tournaments
          WHERE id = '91000000-0000-4000-8000-000000000002')
         IS DISTINCT FROM 2
     OR (SELECT prize_pool FROM pg_temp.tournaments
          WHERE id = '91000000-0000-4000-8000-000000000002')
         IS DISTINCT FROM 360
     OR (SELECT total_rake FROM pg_temp.tournaments
          WHERE id = '91000000-0000-4000-8000-000000000002')
         IS DISTINCT FROM 40
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_settlements)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_awards)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_remainders)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_payouts)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_obligations)
     OR EXISTS (SELECT 1 FROM pg_temp.wallet_credit_idempotency)
     OR EXISTS (SELECT 1 FROM pg_temp.chip_ledger)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_rake_settlements)
     OR (SELECT count(*) FROM pg_temp.rake_records) <> 1
     OR EXISTS (SELECT 1 FROM pg_temp.rake_records
                 WHERE source = 'fn_award_satellite_seat')
     OR (SELECT count(*) FROM pg_temp.tournament_players
          WHERE tournament_id = '91000000-0000-4000-8000-000000000002') <> 2
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_players
                 WHERE tournament_id = '91000000-0000-4000-8000-000000000002'
                   AND source_satellite_id IS NOT NULL)
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tournament_escrow
        WHERE tournament_id = '91000000-0000-4000-8000-000000000001'
          AND prize_balance = 285 AND bounty_balance = 0 AND fee_balance = 10
          AND prize_out = 0 AND fee_out = 0
          AND closed_at IS NULL AND close_note IS NULL)
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tournament_escrow
        WHERE tournament_id = '91000000-0000-4000-8000-000000000002'
          AND prize_balance = 360 AND bounty_balance = 0 AND fee_balance = 40
          AND satellite_in = 0 AND satellite_fee_in = 0
          AND closed_at IS NULL AND close_note IS NULL)
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tables
        WHERE id = '91000000-0000-4000-8000-000000000301'
          AND lower(status::text) = 'running' AND lifecycle = 'live'
          AND current_players = 2 AND terminal_closed_at IS NULL)
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tournament_players
        WHERE id = '91000000-0000-4000-8000-000000000101'
          AND status::text = 'playing' AND position IS NULL AND prize = 0) THEN
    RAISE EXCEPTION 'FAIL % left base settlement artifacts or mutable state',
      p_context;
  END IF;
END;
$probe_helper$;

DO $prestate_matrix$
DECLARE
  v_source_marker_caught boolean := false;
  v_target_marker_caught boolean := false;
  v_target_counter_caught boolean := false;
  v_target_prize_caught boolean := false;
  v_target_rake_caught boolean := false;
  v_negative_level_caught boolean := false;
  v_negative_capacity_caught boolean := false;
  v_negative_late_reg_caught boolean := false;
  v_negative_rebuy_caught boolean := false;
BEGIN
  BEGIN
    UPDATE pg_temp.tournaments SET current_level = -1
     WHERE id = '91000000-0000-4000-8000-000000000002';
    PERFORM pg_temp.fn_settle_satellite_tournament(
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000201');
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_negative_level_caught := true;
  END;
  IF NOT v_negative_level_caught THEN
    RAISE EXCEPTION 'FAIL a negative RUNNING target level was not refused';
  END IF;
  PERFORM pg_temp.assert_base_satellite_unsettled('negative target-level refusal');

  BEGIN
    UPDATE pg_temp.tournaments SET max_players = -1
     WHERE id = '91000000-0000-4000-8000-000000000002';
    PERFORM pg_temp.fn_settle_satellite_tournament(
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000201');
  EXCEPTION WHEN SQLSTATE '22003' THEN
    v_negative_capacity_caught := true;
  END;
  IF NOT v_negative_capacity_caught THEN
    RAISE EXCEPTION 'FAIL a negative target capacity was not refused';
  END IF;
  PERFORM pg_temp.assert_base_satellite_unsettled('negative target-capacity refusal');

  BEGIN
    UPDATE pg_temp.tournaments SET late_reg_levels = -1
     WHERE id = '91000000-0000-4000-8000-000000000002';
    PERFORM pg_temp.fn_settle_satellite_tournament(
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000201');
  EXCEPTION WHEN SQLSTATE '22003' THEN
    v_negative_late_reg_caught := true;
  END;
  IF NOT v_negative_late_reg_caught THEN
    RAISE EXCEPTION 'FAIL a negative target late-registration bound was not refused';
  END IF;
  PERFORM pg_temp.assert_base_satellite_unsettled('negative late-registration refusal');

  BEGIN
    UPDATE pg_temp.tournaments SET rebuy_levels = -1
     WHERE id = '91000000-0000-4000-8000-000000000002';
    PERFORM pg_temp.fn_settle_satellite_tournament(
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000201');
  EXCEPTION WHEN SQLSTATE '22003' THEN
    v_negative_rebuy_caught := true;
  END;
  IF NOT v_negative_rebuy_caught THEN
    RAISE EXCEPTION 'FAIL a negative target rebuy bound was not refused';
  END IF;
  PERFORM pg_temp.assert_base_satellite_unsettled('negative target-rebuy refusal');

  BEGIN
    UPDATE pg_temp.tournament_escrow
       SET closed_at = transaction_timestamp(),
           close_note = 'pre-closed fixture'
     WHERE tournament_id = '91000000-0000-4000-8000-000000000001';
    PERFORM pg_temp.fn_settle_satellite_tournament(
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000201');
  EXCEPTION WHEN SQLSTATE 'P0403' THEN
    v_source_marker_caught := true;
  END;
  IF NOT v_source_marker_caught THEN
    RAISE EXCEPTION 'FAIL a pre-closed source escrow was not refused';
  END IF;
  PERFORM pg_temp.assert_base_satellite_unsettled('source escrow marker refusal');

  BEGIN
    UPDATE pg_temp.tournament_escrow
       SET close_note = 'orphan target close marker'
     WHERE tournament_id = '91000000-0000-4000-8000-000000000002';
    PERFORM pg_temp.fn_settle_satellite_tournament(
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000201');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
    v_target_marker_caught := true;
  END;
  IF NOT v_target_marker_caught THEN
    RAISE EXCEPTION 'FAIL an orphan target escrow close marker was not refused';
  END IF;
  PERFORM pg_temp.assert_base_satellite_unsettled('target escrow marker refusal');

  BEGIN
    UPDATE pg_temp.tournaments SET current_players = 0
     WHERE id = '91000000-0000-4000-8000-000000000002';
    PERFORM pg_temp.fn_settle_satellite_tournament(
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000201');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
    v_target_counter_caught := true;
  END;
  IF NOT v_target_counter_caught THEN
    RAISE EXCEPTION 'FAIL a stale status-aware target entrant counter was not refused';
  END IF;
  PERFORM pg_temp.assert_base_satellite_unsettled('target entrant-counter refusal');

  BEGIN
    UPDATE pg_temp.tournaments SET prize_pool = 359
     WHERE id = '91000000-0000-4000-8000-000000000002';
    PERFORM pg_temp.fn_settle_satellite_tournament(
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000201');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
    v_target_prize_caught := true;
  END;
  IF NOT v_target_prize_caught THEN
    RAISE EXCEPTION 'FAIL a target prize aggregate/escrow mismatch was not refused';
  END IF;
  PERFORM pg_temp.assert_base_satellite_unsettled('target prize-rail refusal');

  BEGIN
    UPDATE pg_temp.tournaments SET total_rake = 39
     WHERE id = '91000000-0000-4000-8000-000000000002';
    PERFORM pg_temp.fn_settle_satellite_tournament(
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000201');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
    v_target_rake_caught := true;
  END;
  IF NOT v_target_rake_caught THEN
    RAISE EXCEPTION 'FAIL a target fee aggregate/escrow mismatch was not refused';
  END IF;
  PERFORM pg_temp.assert_base_satellite_unsettled('target fee-rail refusal');
END;
$prestate_matrix$;

DO $successful_matrix$
DECLARE
  v_receipt jsonb;
  v_repriced_receipt jsonb;
  v_zero_fee_rolled_back boolean := false;
  v_multi_seat_rolled_back boolean := false;
  v_duplicate_target_fee_refused boolean := false;
  v_reprice_refused boolean := false;
BEGIN
  -- A zero-fee target keeps the full ticket on its prize rail. The authority
  -- must not create a synthetic zero-value target rake row.
  BEGIN
    INSERT INTO pg_temp.tournaments(
      id,name,club_id,status,variant,tournament_type,satellite_target_id,
      satellite_target,satellite_seats,prize_pool,prize_pool_finalized,is_bounty,
      is_pko,is_mystery_bounty,is_premium_spin,buy_in_amount,buy_in_fee,
      max_players,current_players,current_level,late_reg_levels,rebuy_levels,
      total_rake,ended_at,on_break,break_ends_at,updated_at)
    VALUES
      ('92000000-0000-4000-8000-000000000001','Zero fee satellite',
       '92000000-0000-4000-8000-000000000010','RUNNING','satellite','SATELLITE',
       '92000000-0000-4000-8000-000000000002',NULL,1,100,true,false,false,
       false,false,10,0,1,1,0,0,0,0,NULL,false,NULL,transaction_timestamp()),
      ('92000000-0000-4000-8000-000000000002','Zero fee target',
       '92000000-0000-4000-8000-000000000010','REGISTERING','holdem','MTT',
       NULL,NULL,0,50,false,false,false,false,false,100,0,100,0,0,10,10,0,
       NULL,false,NULL,transaction_timestamp());
    INSERT INTO pg_temp.tournament_escrow(
      tournament_id,enforced,gross_in,fee_entries_in,satellite_fee_in,bounty_in,
      overlay_in,satellite_in,prize_out,bounty_out,fee_out,refund_prize,
      refund_bounty,refund_fee,prize_balance,bounty_balance,fee_balance,reserve_out,
      reserve_in)
    VALUES
      ('92000000-0000-4000-8000-000000000001',true,0,0,0,0,0,0,0,0,0,0,0,0,
       100,0,0,0,0),
      ('92000000-0000-4000-8000-000000000002',true,50,0,0,0,0,0,0,0,0,0,0,0,
       50,0,0,0,0);
    INSERT INTO pg_temp.tournament_players(
      id,tournament_id,user_id,username,chips,status,position,prize,
      is_satellite_qualifier,source_satellite_id,eliminated_at,
      elimination_sequence)
    VALUES
      ('92000000-0000-4000-8000-000000000101',
       '92000000-0000-4000-8000-000000000001',
       '92000000-0000-4000-8000-000000000201','Zero Fee Winner',0,'eliminated',
       NULL,0,NULL,NULL,transaction_timestamp(),1);
    INSERT INTO pg_temp.tables(
      id,club_id,tournament_id,status,lifecycle,current_players,updated_at)
    VALUES
      ('92000000-0000-4000-8000-000000000301',
       '92000000-0000-4000-8000-000000000010',
       '92000000-0000-4000-8000-000000000001','running','live',1,
       transaction_timestamp());
    INSERT INTO pg_temp.table_seats(
      id,table_id,user_id,left_at,status,leave_pending,is_sitting_out,is_away,
      sit_out_at,scheduled_leave_hands)
    VALUES
      ('92000000-0000-4000-8000-000000000401',
       '92000000-0000-4000-8000-000000000301',
       '92000000-0000-4000-8000-000000000201',NULL,'playing',false,false,false,
       NULL,NULL);

    SELECT pg_temp.fn_settle_satellite_tournament(
             '92000000-0000-4000-8000-000000000001',
             '92000000-0000-4000-8000-000000000201')
      INTO v_receipt;
    IF v_receipt->>'fully_settled' IS DISTINCT FROM 'true'
       OR (v_receipt->>'receipt_version')::integer IS DISTINCT FROM 2
       OR (v_receipt->>'pool')::numeric IS DISTINCT FROM 100
       OR (v_receipt->>'ticket_cost')::numeric IS DISTINCT FROM 100
       OR (v_receipt->>'seat_count')::integer IS DISTINCT FROM 1
       OR (v_receipt->>'cash_ticket_count')::integer IS DISTINCT FROM 0
       OR v_receipt->'remainder' IS DISTINCT FROM 'null'::jsonb
       OR EXISTS (
         SELECT 1 FROM pg_temp.rake_records r
          WHERE r.tournament_id = '92000000-0000-4000-8000-000000000002'
            AND r.source = 'fn_award_satellite_seat')
       OR (SELECT count(*) FROM pg_temp.chip_ledger l
            WHERE l.from_entity_id = '92000000-0000-4000-8000-000000000001') <> 1
       OR (SELECT round(sum(l.amount),2) FROM pg_temp.chip_ledger l
            WHERE l.from_entity_id = '92000000-0000-4000-8000-000000000001')
            IS DISTINCT FROM 100
       OR (SELECT count(*) FROM pg_temp.tournament_payouts p
            WHERE p.tournament_id = '92000000-0000-4000-8000-000000000001') <> 1
       OR (SELECT round(sum(p.amount),2) FROM pg_temp.tournament_payouts p
            WHERE p.tournament_id = '92000000-0000-4000-8000-000000000001')
            IS DISTINCT FROM 100
       OR NOT EXISTS (
         SELECT 1 FROM pg_temp.tournaments
          WHERE id = '92000000-0000-4000-8000-000000000002'
            AND current_players = 1 AND prize_pool = 150 AND total_rake = 0)
       OR NOT EXISTS (
         SELECT 1 FROM pg_temp.tournament_escrow
          WHERE tournament_id = '92000000-0000-4000-8000-000000000002'
            AND satellite_in = 100 AND satellite_fee_in = 0
            AND prize_balance = 150 AND fee_balance = 0)
       OR NOT EXISTS (
         SELECT 1 FROM pg_temp.tournament_escrow
          WHERE tournament_id = '92000000-0000-4000-8000-000000000001'
            AND prize_out = 100 AND prize_balance = 0 AND fee_balance = 0
            AND closed_at IS NOT NULL
            AND close_note = 'atomic satellite terminal receipt: exact zero')
       OR NOT EXISTS (
         SELECT 1 FROM pg_temp.tournament_players tp
          WHERE tp.id = '92000000-0000-4000-8000-000000000101'
            AND tp.status::text = 'winner' AND tp.position = 1
            AND tp.eliminated_at IS NULL AND tp.elimination_sequence IS NULL) THEN
      RAISE EXCEPTION
        'FAIL zero-fee seat did not preserve the full ticket on target prize rails: %',
        v_receipt;
    END IF;
    BEGIN
      UPDATE pg_temp.tournaments
         SET buy_in_amount=125,buy_in_fee=5
       WHERE id='92000000-0000-4000-8000-000000000002';
    EXCEPTION WHEN SQLSTATE '55000' THEN
      v_reprice_refused := true;
    END;
    IF NOT v_reprice_refused THEN
      RAISE EXCEPTION
        'FAIL funded satellite target accepted later economic repricing';
    END IF;
    SELECT pg_temp.fn_ca_satellite_settlement_receipt(
             '92000000-0000-4000-8000-000000000001',
             '92000000-0000-4000-8000-000000000201')
      INTO v_repriced_receipt;
    IF v_repriced_receipt::text IS DISTINCT FROM v_receipt::text THEN
      RAISE EXCEPTION
        'FAIL refused target repricing changed the immutable settlement receipt';
    END IF;
    RAISE EXCEPTION 'rollback successful zero-fee matrix case'
      USING ERRCODE = 'ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN
    v_zero_fee_rolled_back := true;
  END;
  IF NOT v_zero_fee_rolled_back
     OR EXISTS (SELECT 1 FROM pg_temp.tournaments
                 WHERE id IN ('92000000-0000-4000-8000-000000000001',
                              '92000000-0000-4000-8000-000000000002')) THEN
    RAISE EXCEPTION 'FAIL zero-fee matrix case did not roll back its fixture';
  END IF;

  -- Two funded tickets become two registrations. The positive target fee is
  -- split once per seat, while the one residual goes only to the Bubble.
  BEGIN
    INSERT INTO pg_temp.tournaments(
      id,name,club_id,status,variant,tournament_type,satellite_target_id,
      satellite_target,satellite_seats,prize_pool,prize_pool_finalized,is_bounty,
      is_pko,is_mystery_bounty,is_premium_spin,buy_in_amount,buy_in_fee,
      max_players,current_players,current_level,late_reg_levels,rebuy_levels,
      total_rake,ended_at,on_break,break_ends_at,updated_at)
    VALUES
      ('93000000-0000-4000-8000-000000000001','Two seat satellite',
       '93000000-0000-4000-8000-000000000010','RUNNING','satellite','SATELLITE',
       '93000000-0000-4000-8000-000000000002',NULL,2,250,true,false,false,
       false,false,10,0,3,3,0,0,0,0,NULL,false,NULL,transaction_timestamp()),
      ('93000000-0000-4000-8000-000000000002','Two seat target',
       '93000000-0000-4000-8000-000000000010','REGISTERING','holdem','MTT',
       NULL,NULL,0,0,false,false,false,false,false,80,20,100,0,0,10,10,0,
       NULL,false,NULL,transaction_timestamp());
    INSERT INTO pg_temp.tournament_escrow(
      tournament_id,enforced,gross_in,fee_entries_in,satellite_fee_in,bounty_in,
      overlay_in,satellite_in,prize_out,bounty_out,fee_out,refund_prize,
      refund_bounty,refund_fee,prize_balance,bounty_balance,fee_balance,reserve_out,
      reserve_in)
    VALUES
      ('93000000-0000-4000-8000-000000000001',true,0,0,0,0,0,0,0,0,0,0,0,0,
       250,0,0,0,0),
      ('93000000-0000-4000-8000-000000000002',true,0,0,0,0,0,0,0,0,0,0,0,0,
       0,0,0,0,0);
    INSERT INTO pg_temp.tournament_players(
      id,tournament_id,user_id,username,chips,status,position,prize,
      is_satellite_qualifier,source_satellite_id,elimination_sequence)
    VALUES
      ('93000000-0000-4000-8000-000000000101',
       '93000000-0000-4000-8000-000000000001',
       '93000000-0000-4000-8000-000000000201','Seat One',100,'playing',NULL,0,
       NULL,NULL,NULL),
      ('93000000-0000-4000-8000-000000000102',
       '93000000-0000-4000-8000-000000000001',
       '93000000-0000-4000-8000-000000000202','Seat Two',0,'eliminated',NULL,0,
       NULL,NULL,2),
      ('93000000-0000-4000-8000-000000000103',
       '93000000-0000-4000-8000-000000000001',
       '93000000-0000-4000-8000-000000000203','Bubble Residual',0,'eliminated',
       NULL,0,NULL,NULL,1);
    INSERT INTO pg_temp.tables(
      id,club_id,tournament_id,status,lifecycle,current_players,updated_at)
    VALUES
      ('93000000-0000-4000-8000-000000000301',
       '93000000-0000-4000-8000-000000000010',
       '93000000-0000-4000-8000-000000000001','running','live',1,
       transaction_timestamp());
    INSERT INTO pg_temp.table_seats(
      id,table_id,user_id,left_at,status,leave_pending,is_sitting_out,is_away,
      sit_out_at,scheduled_leave_hands)
    VALUES
      ('93000000-0000-4000-8000-000000000401',
       '93000000-0000-4000-8000-000000000301',
       '93000000-0000-4000-8000-000000000201',NULL,'playing',false,false,false,
       NULL,NULL);

    SELECT pg_temp.fn_settle_satellite_tournament(
             '93000000-0000-4000-8000-000000000001',
             '93000000-0000-4000-8000-000000000201')
      INTO v_receipt;
    IF v_receipt->>'fully_settled' IS DISTINCT FROM 'true'
       OR (v_receipt->>'receipt_version')::integer IS DISTINCT FROM 2
       OR (v_receipt->>'pool')::numeric IS DISTINCT FROM 250
       OR (v_receipt->>'ticket_cost')::numeric IS DISTINCT FROM 100
       OR (v_receipt->>'ticket_award_count')::integer IS DISTINCT FROM 2
       OR (v_receipt->>'seat_count')::integer IS DISTINCT FROM 2
       OR (v_receipt->>'cash_ticket_count')::integer IS DISTINCT FROM 0
       OR (v_receipt->'remainder'->>'amount')::numeric IS DISTINCT FROM 50
       OR v_receipt->'remainder'->>'user_id'
            IS DISTINCT FROM '93000000-0000-4000-8000-000000000203'
       OR (v_receipt->'remainder'->>'position')::integer IS DISTINCT FROM 3
       OR (SELECT count(*) FROM pg_temp.tournament_players tp
            WHERE tp.tournament_id = '93000000-0000-4000-8000-000000000002'
              AND tp.source_satellite_id = '93000000-0000-4000-8000-000000000001'
              AND tp.status::text = 'registered') <> 2
       OR (SELECT count(*) FROM pg_temp.chip_ledger l
            WHERE l.from_entity_id = '93000000-0000-4000-8000-000000000001'
              AND l.to_entity_id = '93000000-0000-4000-8000-000000000002') <> 2
       OR (SELECT round(sum(l.amount),2) FROM pg_temp.chip_ledger l
            WHERE l.from_entity_id = '93000000-0000-4000-8000-000000000001')
            IS DISTINCT FROM 200
       OR (SELECT count(*) FROM pg_temp.rake_records r
            WHERE r.tournament_id = '93000000-0000-4000-8000-000000000002'
              AND r.source = 'fn_award_satellite_seat') <> 2
       OR (SELECT round(sum(r.rake_amount),2) FROM pg_temp.rake_records r
            WHERE r.tournament_id = '93000000-0000-4000-8000-000000000002'
              AND r.source = 'fn_award_satellite_seat') IS DISTINCT FROM 40
       OR EXISTS (
         SELECT 1 FROM pg_temp.rake_records r
          WHERE r.tournament_id = '93000000-0000-4000-8000-000000000002'
            AND r.source = 'fn_award_satellite_seat'
            AND (r.rake_amount IS DISTINCT FROM 20 OR r.pot_size IS DISTINCT FROM 100))
       OR NOT EXISTS (
         SELECT 1 FROM pg_temp.tournaments
          WHERE id = '93000000-0000-4000-8000-000000000002'
            AND current_players = 2 AND prize_pool = 160 AND total_rake = 40)
       OR NOT EXISTS (
         SELECT 1 FROM pg_temp.tournament_escrow
          WHERE tournament_id = '93000000-0000-4000-8000-000000000002'
            AND satellite_in = 160 AND satellite_fee_in = 40
            AND prize_balance = 160 AND fee_balance = 40)
       OR (SELECT count(*) FROM pg_temp.tournament_payouts p
            WHERE p.tournament_id = '93000000-0000-4000-8000-000000000001') <> 3
       OR (SELECT round(sum(p.amount),2) FROM pg_temp.tournament_payouts p
            WHERE p.tournament_id = '93000000-0000-4000-8000-000000000001')
            IS DISTINCT FROM 250
       OR (SELECT count(*) FROM pg_temp.tournament_satellite_awards a
            WHERE a.tournament_id = '93000000-0000-4000-8000-000000000001'
              AND a.delivery_kind = 'seat') <> 2
       OR NOT EXISTS (
         SELECT 1 FROM pg_temp.tournament_satellite_remainders r
          WHERE r.tournament_id = '93000000-0000-4000-8000-000000000001'
            AND r.user_id = '93000000-0000-4000-8000-000000000203'
            AND r.place = 3 AND r.amount = 50)
       OR NOT EXISTS (
         SELECT 1 FROM pg_temp.tournament_escrow
          WHERE tournament_id = '93000000-0000-4000-8000-000000000001'
            AND prize_out = 250 AND prize_balance = 0 AND fee_balance = 0
            AND closed_at IS NOT NULL
            AND close_note = 'atomic satellite terminal receipt: exact zero') THEN
      RAISE EXCEPTION
        'FAIL two-seat delivery did not conserve its exact pool and target deltas: %',
        v_receipt;
    END IF;
    UPDATE pg_temp.rake_records changed
       SET metadata = jsonb_set(
         jsonb_set(changed.metadata,'{registration_id}',
                   to_jsonb(first_row.metadata->>'registration_id')),
         '{user_id}',to_jsonb(first_row.metadata->>'user_id'))
      FROM (
        SELECT r.metadata
          FROM pg_temp.rake_records r
         WHERE r.tournament_id='93000000-0000-4000-8000-000000000002'
           AND r.source='fn_award_satellite_seat'
         ORDER BY r.id LIMIT 1
      ) first_row
     WHERE changed.id = (
       SELECT r.id FROM pg_temp.rake_records r
        WHERE r.tournament_id='93000000-0000-4000-8000-000000000002'
          AND r.source='fn_award_satellite_seat'
        ORDER BY r.id DESC LIMIT 1);
    BEGIN
      PERFORM pg_temp.fn_ca_satellite_settlement_receipt(
        '93000000-0000-4000-8000-000000000001',
        '93000000-0000-4000-8000-000000000201');
    EXCEPTION WHEN SQLSTATE 'P0404' THEN
      v_duplicate_target_fee_refused := true;
    END;
    IF NOT v_duplicate_target_fee_refused THEN
      RAISE EXCEPTION
        'FAIL duplicate target fee registration passed exact receipt verification';
    END IF;
    RAISE EXCEPTION 'rollback successful multi-seat matrix case'
      USING ERRCODE = 'ZX002';
  EXCEPTION WHEN SQLSTATE 'ZX002' THEN
    v_multi_seat_rolled_back := true;
  END;
  IF NOT v_multi_seat_rolled_back
     OR EXISTS (SELECT 1 FROM pg_temp.tournaments
                 WHERE id IN ('93000000-0000-4000-8000-000000000001',
                              '93000000-0000-4000-8000-000000000002')) THEN
    RAISE EXCEPTION 'FAIL multi-seat matrix case did not roll back its fixture';
  END IF;
END;
$successful_matrix$;

-- Prove both inverse edges that the retired hand-written predicate got wrong.
-- A literal late_reg_levels=0 selects the canonical minutes window; a NULL
-- rebuy_levels value is valid and must not replace that decision. A NULL
-- late_reg_levels with a positive rebuy fallback and NULL current_level uses
-- canonical level zero. Each complete settlement is rolled back after its
-- immutable receipt proves whether the funded ticket became a seat or a cash
-- substitution.
DO $minutes_late_registration_matrix$
DECLARE
  v_case record;
  v_receipt jsonb;
  v_rolled_back boolean;
BEGIN
  FOR v_case IN
    SELECT * FROM (VALUES
      ('94000000-0000-4000-8000-000000000001'::uuid,
       '94000000-0000-4000-8000-000000000002'::uuid,
       '94000000-0000-4000-8000-000000000010'::uuid,
       '94000000-0000-4000-8000-000000000201'::uuid,
       '94000000-0000-4000-8000-000000000301'::uuid,
       '94000000-0000-4000-8000-000000000401'::uuid,
       interval '10 minutes',5,0,NULL,60,1,'minutes-open'),
      ('95000000-0000-4000-8000-000000000001'::uuid,
       '95000000-0000-4000-8000-000000000002'::uuid,
       '95000000-0000-4000-8000-000000000010'::uuid,
       '95000000-0000-4000-8000-000000000201'::uuid,
       '95000000-0000-4000-8000-000000000301'::uuid,
       '95000000-0000-4000-8000-000000000401'::uuid,
       interval '120 minutes',1,0,NULL,60,0,'minutes-closed'),
      ('96000000-0000-4000-8000-000000000001'::uuid,
       '96000000-0000-4000-8000-000000000002'::uuid,
       '96000000-0000-4000-8000-000000000010'::uuid,
       '96000000-0000-4000-8000-000000000201'::uuid,
       '96000000-0000-4000-8000-000000000301'::uuid,
       '96000000-0000-4000-8000-000000000401'::uuid,
       interval '10 minutes',NULL,NULL,4,60,1,'level-fallback-null-current')
    ) fixture(
      source_id,target_id,club_id,winner_id,table_id,seat_id,
      elapsed,current_level,late_reg_levels,rebuy_levels,late_reg_mins,
      expected_seats,label)
  LOOP
    v_rolled_back := false;
    BEGIN
      INSERT INTO pg_temp.tournaments(
        id,name,club_id,status,variant,tournament_type,satellite_target_id,
        satellite_target,satellite_seats,prize_pool,prize_pool_finalized,
        is_bounty,is_pko,is_mystery_bounty,is_premium_spin,
        buy_in_amount,buy_in_fee,max_players,current_players,current_level,
        late_reg_levels,rebuy_levels,late_reg_mins,started_at,total_rake,
        ended_at,on_break,break_ends_at,updated_at)
      VALUES
        (v_case.source_id,v_case.label || ' satellite',v_case.club_id,
         'RUNNING','satellite','SATELLITE',v_case.target_id,NULL,1,100,true,
         false,false,false,false,10,0,1,1,0,0,0,0,
         clock_timestamp()-interval '20 minutes',0,NULL,false,NULL,
         transaction_timestamp()),
        (v_case.target_id,v_case.label || ' target',v_case.club_id,
         'RUNNING','holdem','MTT',NULL,NULL,0,0,false,
         false,false,false,false,100,0,100,0,v_case.current_level,
         v_case.late_reg_levels,v_case.rebuy_levels,v_case.late_reg_mins,
         clock_timestamp()-v_case.elapsed,0,NULL,false,NULL,
         transaction_timestamp());

      INSERT INTO pg_temp.tournament_escrow(
        tournament_id,enforced,gross_in,fee_entries_in,satellite_fee_in,
        bounty_in,overlay_in,satellite_in,prize_out,bounty_out,fee_out,
        refund_prize,refund_bounty,refund_fee,prize_balance,bounty_balance,
        fee_balance,reserve_out,reserve_in)
      VALUES
        (v_case.source_id,true,0,0,0,0,0,0,0,0,0,0,0,0,100,0,0,0,0),
        (v_case.target_id,true,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);

      INSERT INTO pg_temp.tournament_players(
        tournament_id,user_id,username,chips,status,position,prize,
        is_satellite_qualifier,source_satellite_id,eliminated_at,
        elimination_sequence)
      VALUES
        (v_case.source_id,v_case.winner_id,v_case.label || ' winner',0,
         'eliminated',NULL,0,NULL,NULL,clock_timestamp(),1);
      INSERT INTO pg_temp.tables(
        id,club_id,tournament_id,status,lifecycle,current_players,updated_at)
      VALUES
        (v_case.table_id,v_case.club_id,v_case.source_id,
         'running','live',1,transaction_timestamp());
      INSERT INTO pg_temp.table_seats(
        id,table_id,user_id,left_at,status,leave_pending,is_sitting_out,
        is_away,sit_out_at,scheduled_leave_hands)
      VALUES
        (v_case.seat_id,v_case.table_id,v_case.winner_id,NULL,'playing',
         false,false,false,NULL,NULL);

      SELECT pg_temp.fn_settle_satellite_tournament(
               v_case.source_id,v_case.winner_id)
        INTO v_receipt;
      IF v_receipt->>'fully_settled' IS DISTINCT FROM 'true'
         OR (v_receipt->>'ticket_award_count')::integer IS DISTINCT FROM 1
         OR (v_receipt->>'seat_count')::integer
              IS DISTINCT FROM v_case.expected_seats
         OR (v_receipt->>'cash_ticket_count')::integer
              IS DISTINCT FROM 1-v_case.expected_seats
         OR v_receipt->'awards'->0->>'delivery_kind' IS DISTINCT FROM
              (CASE WHEN v_case.expected_seats=1 THEN 'seat' ELSE 'cash' END)
         OR (SELECT count(*) FROM pg_temp.tournament_players tp
              WHERE tp.tournament_id=v_case.target_id
                AND tp.source_satellite_id=v_case.source_id)
              IS DISTINCT FROM v_case.expected_seats::bigint
         OR (SELECT prize_pool FROM pg_temp.tournaments t
              WHERE t.id=v_case.target_id)
              IS DISTINCT FROM (100*v_case.expected_seats)::numeric THEN
        RAISE EXCEPTION
          'FAIL % canonical minutes fixture chose the wrong delivery: %',
          v_case.label,v_receipt;
      END IF;
      RAISE EXCEPTION 'rollback successful canonical minutes fixture'
        USING ERRCODE = 'ZX003';
    EXCEPTION WHEN SQLSTATE 'ZX003' THEN
      v_rolled_back := true;
    END;
    IF NOT v_rolled_back
       OR EXISTS (
         SELECT 1 FROM pg_temp.tournaments t
          WHERE t.id IN (v_case.source_id,v_case.target_id)) THEN
      RAISE EXCEPTION 'FAIL % fixture did not roll back',v_case.label;
    END IF;
  END LOOP;
END;
$minutes_late_registration_matrix$;

DO $probe$
DECLARE
  v_caught boolean := false;
  v_source_escrow_caught boolean := false;
  v_target_split_caught boolean := false;
  v_negative_target_caught boolean := false;
  v_missing_target_caught boolean := false;
  v_target_guard_caught boolean := false;
  v_null_marker_caught boolean := false;
  v_mismatch_marker_caught boolean := false;
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

  UPDATE pg_temp.tournament_escrow SET reserve_in = 1,reserve_out = 1
   WHERE tournament_id = '91000000-0000-4000-8000-000000000001';
  BEGIN
    PERFORM pg_temp.fn_settle_satellite_tournament(
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000201');
  EXCEPTION WHEN SQLSTATE 'P0403' THEN
    v_source_escrow_caught := true;
  END;
  UPDATE pg_temp.tournament_escrow SET reserve_in = 0,reserve_out = 0
   WHERE tournament_id = '91000000-0000-4000-8000-000000000001';
  IF NOT v_source_escrow_caught
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_settlements)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_awards)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_remainders)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_payouts)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_obligations)
     OR EXISTS (SELECT 1 FROM pg_temp.wallet_credit_idempotency)
     OR EXISTS (SELECT 1 FROM pg_temp.chip_ledger)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_rake_settlements)
     OR (SELECT count(*) FROM pg_temp.tournament_players
          WHERE tournament_id = '91000000-0000-4000-8000-000000000002') <> 2 THEN
    RAISE EXCEPTION
      'FAIL malformed source escrow history was not refused before any write';
  END IF;

  -- A bounty target requires separate prize and bounty escrow rails. Prove the
  -- generic satellite authority refuses it before creating any target seat or
  -- any financial/evidence row.
  UPDATE pg_temp.tournaments SET is_bounty = true
   WHERE id = '91000000-0000-4000-8000-000000000002';
  BEGIN
    PERFORM pg_temp.fn_settle_satellite_tournament(
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000201');
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_target_split_caught := true;
  END;
  UPDATE pg_temp.tournaments SET is_bounty = false
   WHERE id = '91000000-0000-4000-8000-000000000002';
  IF NOT v_target_split_caught
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_settlements)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_awards)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_remainders)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_payouts)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_obligations)
     OR EXISTS (SELECT 1 FROM pg_temp.wallet_credit_idempotency)
     OR EXISTS (SELECT 1 FROM pg_temp.chip_ledger)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_rake_settlements)
     OR (SELECT count(*) FROM pg_temp.tournament_players
          WHERE tournament_id = '91000000-0000-4000-8000-000000000002') <> 2
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_players
                 WHERE tournament_id = '91000000-0000-4000-8000-000000000002'
                   AND source_satellite_id IS NOT NULL) THEN
    RAISE EXCEPTION
      'FAIL bounty target split was not refused before any write';
  END IF;

  UPDATE pg_temp.tournament_escrow SET prize_balance = -1
   WHERE tournament_id = '91000000-0000-4000-8000-000000000002';
  BEGIN
    PERFORM pg_temp.fn_settle_satellite_tournament(
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000201');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
    v_negative_target_caught := true;
  END;
  UPDATE pg_temp.tournament_escrow SET prize_balance = 360
   WHERE tournament_id = '91000000-0000-4000-8000-000000000002';
  IF NOT v_negative_target_caught
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_settlements)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_awards)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_remainders)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_payouts)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_obligations)
     OR EXISTS (SELECT 1 FROM pg_temp.wallet_credit_idempotency)
     OR EXISTS (SELECT 1 FROM pg_temp.chip_ledger)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_rake_settlements)
     OR (SELECT count(*) FROM pg_temp.tournament_players
          WHERE tournament_id = '91000000-0000-4000-8000-000000000002') <> 2
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_players
                 WHERE tournament_id = '91000000-0000-4000-8000-000000000002'
                   AND source_satellite_id IS NOT NULL) THEN
    RAISE EXCEPTION
      'FAIL negative target escrow was not refused before any write';
  END IF;

  -- An absent target cannot be row-locked against a concurrent same-id insert.
  -- The authority must refuse the whole settlement instead of pricing cash
  -- from an independent contract row.
  BEGIN
    DELETE FROM pg_temp.tournaments
     WHERE id = '91000000-0000-4000-8000-000000000002';
    PERFORM pg_temp.fn_settle_satellite_tournament(
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000201');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
    v_missing_target_caught := true;
  END;
  IF NOT v_missing_target_caught
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tournaments
        WHERE id = '91000000-0000-4000-8000-000000000002')
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_settlements)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_awards)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_remainders)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_payouts)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_obligations)
     OR EXISTS (SELECT 1 FROM pg_temp.wallet_credit_idempotency)
     OR EXISTS (SELECT 1 FROM pg_temp.chip_ledger)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_rake_settlements) THEN
    RAISE EXCEPTION
      'FAIL missing target was not refused before any write';
  END IF;

  -- Prove the authority itself rejects a no-op target fee rail. This is not a
  -- migration-time source check: the per-call before/after escrow assertion
  -- must abort every ticket, cache and evidence write in the same transaction.
  EXECUTE
    'ALTER TABLE pg_temp.rake_records DISABLE TRIGGER probe_target_fee_reclassifies';
  BEGIN
    PERFORM pg_temp.fn_settle_satellite_tournament(
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000201');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
    v_target_guard_caught := true;
  END;
  EXECUTE
    'ALTER TABLE pg_temp.rake_records ENABLE TRIGGER probe_target_fee_reclassifies';
  IF NOT v_target_guard_caught
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_settlements)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_awards)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_remainders)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_payouts)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_obligations)
     OR EXISTS (SELECT 1 FROM pg_temp.wallet_credit_idempotency)
     OR EXISTS (SELECT 1 FROM pg_temp.chip_ledger)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_rake_settlements)
     OR (SELECT count(*) FROM pg_temp.tournament_players
          WHERE tournament_id = '91000000-0000-4000-8000-000000000002') <> 2
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_players
                 WHERE tournament_id = '91000000-0000-4000-8000-000000000002'
                   AND source_satellite_id IS NOT NULL)
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tournament_escrow
        WHERE tournament_id = '91000000-0000-4000-8000-000000000002'
          AND satellite_in = 0 AND satellite_fee_in = 0
          AND prize_balance = 360 AND fee_balance = 40) THEN
    RAISE EXCEPTION
      'FAIL missing target fee rail was not caught and fully rolled back';
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
          WHERE id = '91000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 'RUNNING'
     OR (SELECT prize_pool FROM pg_temp.tournaments
          WHERE id = '91000000-0000-4000-8000-000000000002')
          IS DISTINCT FROM 360
     OR (SELECT total_rake FROM pg_temp.tournaments
          WHERE id = '91000000-0000-4000-8000-000000000002')
          IS DISTINCT FROM 40
     OR (SELECT current_players FROM pg_temp.tournaments
          WHERE id = '91000000-0000-4000-8000-000000000002')
          IS DISTINCT FROM 2
     OR (SELECT count(*) FROM pg_temp.tournament_players
          WHERE tournament_id = '91000000-0000-4000-8000-000000000002') <> 2
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_players
                 WHERE tournament_id = '91000000-0000-4000-8000-000000000002'
                   AND source_satellite_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_payouts)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_obligations)
     OR EXISTS (SELECT 1 FROM pg_temp.wallet_credit_idempotency)
     OR EXISTS (SELECT 1 FROM pg_temp.chip_ledger)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_rake_settlements)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_settlements)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_awards)
     OR EXISTS (SELECT 1 FROM pg_temp.tournament_satellite_remainders)
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
          AND prize_balance = 360 AND bounty_balance = 0 AND fee_balance = 40
          AND satellite_in = 0 AND satellite_fee_in = 0)
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tables
        WHERE id = '91000000-0000-4000-8000-000000000301'
          AND lower(status::text) = 'running' AND lifecycle = 'live'
          AND current_players = 2 AND terminal_closed_at IS NULL)
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.table_seats
        WHERE id = '91000000-0000-4000-8000-000000000401'
          AND left_at IS NULL AND status = 'playing'
          AND leave_pending IS FALSE AND is_sitting_out IS FALSE
          AND is_away IS FALSE AND sit_out_at IS NULL
          AND scheduled_leave_hands IS NULL)
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.table_seats
        WHERE id = '91000000-0000-4000-8000-000000000402'
          AND left_at = '2026-09-08 10:00:00+00'::timestamptz
          AND status = 'active'
          AND leave_pending IS TRUE AND is_sitting_out IS TRUE
          AND is_away IS TRUE
          AND sit_out_at = '2026-09-08 09:59:00+00'::timestamptz
          AND scheduled_leave_hands = 2)
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
  BEGIN
    UPDATE pg_temp.tables SET terminal_closed_at = NULL
     WHERE id = '91000000-0000-4000-8000-000000000301';
    PERFORM pg_temp.fn_ca_satellite_settlement_receipt(
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000201');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
    v_null_marker_caught := true;
  END;
  BEGIN
    UPDATE pg_temp.tables
       SET terminal_closed_at = terminal_closed_at + interval '1 second'
     WHERE id = '91000000-0000-4000-8000-000000000301';
    PERFORM pg_temp.fn_ca_satellite_settlement_receipt(
      '91000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000201');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
    v_mismatch_marker_caught := true;
  END;
  SELECT pg_temp.fn_settle_satellite_tournament(
           '91000000-0000-4000-8000-000000000001',
           '91000000-0000-4000-8000-000000000201')
    INTO v_replay;
  SELECT pg_temp.fn_resolve_satellite_settlement_outcome(
           '91000000-0000-4000-8000-000000000001',
           '91000000-0000-4000-8000-000000000201')
    INTO v_after_outcome;

  IF NOT v_null_marker_caught OR NOT v_mismatch_marker_caught
     OR v_replay IS DISTINCT FROM v_first
     OR v_after_outcome->>'ok' IS DISTINCT FROM 'true'
     OR v_after_outcome->>'satellite_committed' IS DISTINCT FROM 'true'
     OR v_after_outcome->>'definitively_not_committed' IS DISTINCT FROM 'false'
     OR v_after_outcome->>'status' IS DISTINCT FROM 'COMPLETED'
     OR v_after_outcome->'receipt' IS DISTINCT FROM v_first
     OR v_first->>'ok' IS DISTINCT FROM 'true'
     OR v_first->>'fully_settled' IS DISTINCT FROM 'true'
     OR v_first->>'status' IS DISTINCT FROM 'COMPLETED'
     OR (v_first->>'receipt_version')::integer IS DISTINCT FROM 2
     OR (v_first->>'source_table_count')::integer IS DISTINCT FROM 1
     OR (v_first->>'source_seat_count')::integer IS DISTINCT FROM 2
     OR (v_first->>'released_seat_count')::integer IS DISTINCT FROM 1
     OR v_first->'source_closeout'->'source_table_ids' IS DISTINCT FROM
          '["91000000-0000-4000-8000-000000000301"]'::jsonb
     OR v_first->'source_closeout'->'source_seat_ids' IS DISTINCT FROM
          '["91000000-0000-4000-8000-000000000401",
            "91000000-0000-4000-8000-000000000402"]'::jsonb
     OR v_first->'source_closeout'->'released_seat_ids' IS DISTINCT FROM
          '["91000000-0000-4000-8000-000000000401"]'::jsonb
     OR (v_first->'source_closeout'->>'closed_at')::timestamptz
          IS DISTINCT FROM (
            SELECT t.ended_at FROM pg_temp.tournaments t
             WHERE t.id = '91000000-0000-4000-8000-000000000001')
     OR (v_first->'source_closeout'->>'closed_at')::timestamptz
          IS DISTINCT FROM (
            SELECT h.source_closed_at
              FROM pg_temp.tournament_satellite_settlements h
             WHERE h.tournament_id = '91000000-0000-4000-8000-000000000001')
     OR (v_first->>'settled_at')::timestamptz
          IS DISTINCT FROM (
            SELECT h.settled_at
              FROM pg_temp.tournament_satellite_settlements h
             WHERE h.tournament_id = '91000000-0000-4000-8000-000000000001')
     OR (SELECT status FROM pg_temp.tournaments
          WHERE id = '91000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 'COMPLETED'
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tables
        WHERE id = '91000000-0000-4000-8000-000000000301'
          AND lower(status::text) = 'closed' AND lifecycle = 'closed'
          AND current_players = 0
          AND terminal_closed_at = (
            SELECT ended_at FROM pg_temp.tournaments
             WHERE id = '91000000-0000-4000-8000-000000000001'))
     OR (SELECT count(*) FROM pg_temp.table_seats
          WHERE status = 'left' AND left_at IS NOT NULL
            AND leave_pending IS FALSE AND is_sitting_out IS FALSE
            AND is_away IS FALSE AND sit_out_at IS NULL
            AND scheduled_leave_hands IS NULL) <> 2
     OR EXISTS (
       SELECT 1
         FROM pg_temp.table_seats ts
         CROSS JOIN pg_temp.tournament_satellite_settlements h
        WHERE h.tournament_id = '91000000-0000-4000-8000-000000000001'
          AND ts.id = ANY(h.released_seat_ids)
          AND ts.left_at IS DISTINCT FROM h.settled_at)
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.table_seats
        WHERE id = '91000000-0000-4000-8000-000000000402'
          AND left_at = '2026-09-08 10:00:00+00'::timestamptz
          AND status = 'left'
          AND leave_pending IS FALSE AND is_sitting_out IS FALSE
          AND is_away IS FALSE AND sit_out_at IS NULL
          AND scheduled_leave_hands IS NULL)
     OR (SELECT count(*) FROM pg_temp.tournament_satellite_settlements) <> 1
     OR (SELECT count(*) FROM pg_temp.tournament_satellite_awards) <> 1
     OR (SELECT count(*) FROM pg_temp.tournament_satellite_remainders) <> 1
     OR (SELECT count(*) FROM pg_temp.tournament_payouts) <> 2
     OR (SELECT round(sum(amount),2) FROM pg_temp.tournament_payouts)
          IS DISTINCT FROM 285.00
     OR (SELECT count(*) FROM pg_temp.tournament_rake_settlements) <> 1
     OR (SELECT current_players FROM pg_temp.tournaments
          WHERE id = '91000000-0000-4000-8000-000000000002')
          IS DISTINCT FROM 3
     OR (SELECT prize_pool FROM pg_temp.tournaments
          WHERE id = '91000000-0000-4000-8000-000000000002')
          IS DISTINCT FROM 540
     OR (SELECT total_rake FROM pg_temp.tournaments
          WHERE id = '91000000-0000-4000-8000-000000000002')
          IS DISTINCT FROM 60
     OR (SELECT count(*) FROM pg_temp.tournament_players
          WHERE tournament_id = '91000000-0000-4000-8000-000000000002') <> 3
     OR (SELECT count(*) FROM pg_temp.tournament_players
          WHERE tournament_id = '91000000-0000-4000-8000-000000000002'
            AND status::text IN ('registered','playing')) <> 2
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tournament_players
        WHERE id = '91000000-0000-4000-8000-000000000110'
          AND status::text = 'eliminated')
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tournament_escrow
        WHERE tournament_id = '91000000-0000-4000-8000-000000000001'
          AND prize_balance = 0 AND bounty_balance = 0 AND fee_balance = 0
          AND closed_at IS NOT NULL
          AND close_note = 'atomic satellite terminal receipt: exact zero')
     OR NOT EXISTS (
       SELECT 1 FROM pg_temp.tournament_escrow
        WHERE tournament_id = '91000000-0000-4000-8000-000000000002'
          AND prize_balance = 540 AND bounty_balance = 0 AND fee_balance = 60
          AND satellite_in = 180 AND satellite_fee_in = 20)
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
    'AUDIT_TEST_PASS: canonical minutes-open, minutes-closed and NULL-current level-fallback fixtures accepted valid NULL bounds and selected seat, cash and seat respectively; pre-closed escrow and a stale status-aware target entrant counter, prize and fee aggregates were rejected with zero artifacts; zero-fee and two-seat target deliveries conserved their exact whole pools and escrow rails; missing, bounty and malformed-escrow targets, a missing target fee rail and an injected source-table close refusal were rejected with full rollback; a RUNNING late-registration target preserved its total entrant counter despite a historical eliminated row; NULL and mismatched terminal markers invalidated replay; removing the faults produced one exact closeout and byte-identical receipt';
END;
$probe$;
