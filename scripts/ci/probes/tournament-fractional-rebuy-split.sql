-- Run as postgres on a disposable database after 20260909014433.
-- This semantic probe creates two isolated tournaments inside one transaction,
-- exercises the owner-only chip-purchase money core, and rolls every fixture
-- row back. It proves that the whole advertised total is split inward to
-- cent-accurate fee, bounty and prize rails, including the immutable refund
-- entitlement and both escrow representations.
\set ON_ERROR_STOP on

BEGIN;

DO $prerequisites$
BEGIN
  IF current_user <> 'postgres'
     OR to_regprocedure(
       'public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)')
          IS NULL
     OR to_regprocedure(
       'public.fn_ca_tournament_charge_split(uuid,text,numeric)') IS NULL
     OR to_regprocedure('public.fn_ca_tournament_escrow(uuid)') IS NULL
     OR to_regclass('public.tournament_refund_entitlements') IS NULL
     OR to_regclass('public.tournament_escrow') IS NULL THEN
    RAISE EXCEPTION
      'fractional rebuy probe requires postgres and the complete 14433 replay';
  END IF;
END;
$prerequisites$;

-- Fixture insertion is deliberately trigger-free. The calls under test run
-- with every production trigger enabled below.
SET LOCAL session_replication_role = replica;

INSERT INTO auth.users(id)
VALUES ('f1000000-0000-0000-0000-000000000001');

INSERT INTO public.profiles(id,username,display_name)
VALUES (
  'f1000000-0000-0000-0000-000000000001',
  'fractional_rebuy_probe','Fractional Rebuy Probe');

INSERT INTO public.clubs(id,name,total_rake,chip_pool)
VALUES
  ('f2000000-0000-0000-0000-000000000001',
   'Fractional Rebuy Fee Recipient Club',0,1000),
  ('f2000000-0000-0000-0000-000000000002',
   'Fractional Rebuy Funding Wallet Club',0,1000);

INSERT INTO public.club_members(
  club_id,user_id,role,status,is_active,chip_balance)
VALUES (
  'f2000000-0000-0000-0000-000000000002',
  'f1000000-0000-0000-0000-000000000001',
  'player','active',true,100);

-- buy_in_amount + buy_in_fee is the advertised 15 total. For a bounty
-- tournament the 1.50 head also comes out of that total, leaving 12 for prize.
INSERT INTO public.tournaments(
  id,name,game_type,buy_in_amount,buy_in_fee,start_time,status,
  current_players,max_players,starting_chips,club_id,current_level,
  prize_pool,is_rebuy,is_reentry,rebuy_cost,rebuy_chips,rebuy_levels,
  late_reg_levels,max_rebuys,is_bounty,bounty_amount,is_pko,is_mystery_bounty,
  bounty_pool,total_rake,add_on_available)
VALUES (
  'f3000000-0000-0000-0000-000000000001',
  'Fractional Bounty Rebuy Probe','NLH',13.50,1.50,
  clock_timestamp()-interval '1 minute','RUNNING',1,9,100,
  'f2000000-0000-0000-0000-000000000001',1,
  0,true,false,15,100,5,5,5,true,1.50,false,false,0,0,false);

INSERT INTO public.tournament_players(
  id,tournament_id,user_id,chips,status,prize,rebuys,add_on,club_id)
VALUES (
  'f4000000-0000-0000-0000-000000000001',
  'f3000000-0000-0000-0000-000000000001',
  'f1000000-0000-0000-0000-000000000001',
  0,'playing',0,0,false,
  'f2000000-0000-0000-0000-000000000002');

INSERT INTO public.tournament_escrow(
  tournament_id,enforced,opened_from,opened_at,updated_at)
VALUES (
  'f3000000-0000-0000-0000-000000000001',true,
  'fractional-rebuy-semantic-probe',clock_timestamp(),clock_timestamp());

-- A separate live-seat fixture proves the add-on path is actually unraked,
-- rather than merely relying on a source-code branch assertion.
INSERT INTO public.tournaments(
  id,name,game_type,buy_in_amount,buy_in_fee,start_time,status,
  current_players,max_players,starting_chips,club_id,current_level,
  prize_pool,is_rebuy,is_reentry,rebuy_cost,rebuy_chips,rebuy_levels,
  late_reg_levels,is_bounty,bounty_amount,is_pko,is_mystery_bounty,
  bounty_pool,total_rake,add_on_available,addon_period_triggered,
  addon_cost,addon_chips)
VALUES (
  'f3000000-0000-0000-0000-000000000002',
  'Unraked Add-On Probe','NLH',13.50,1.50,
  clock_timestamp()-interval '1 minute','RUNNING',1,9,100,
  'f2000000-0000-0000-0000-000000000001',1,
  0,false,false,0,0,5,5,true,1.50,false,false,0,0,
  true,true,15,100);

INSERT INTO public.tables(
  id,club_id,name,game_type,max_players,current_players,status,
  tournament_id,lifecycle)
VALUES (
  'f5000000-0000-0000-0000-000000000001',
  'f2000000-0000-0000-0000-000000000001',
  'Unraked Add-On Probe Table','tournament',9,1,'running',
  'f3000000-0000-0000-0000-000000000002','live');

INSERT INTO public.tournament_players(
  id,tournament_id,user_id,chips,status,prize,rebuys,add_on,
  table_id,seat_number,club_id)
VALUES (
  'f4000000-0000-0000-0000-000000000002',
  'f3000000-0000-0000-0000-000000000002',
  'f1000000-0000-0000-0000-000000000001',
  10,'playing',0,0,false,
  'f5000000-0000-0000-0000-000000000001',1,
  'f2000000-0000-0000-0000-000000000002');

INSERT INTO public.table_seats(
  id,table_id,seat_number,user_id,stack,status,joined_at,left_at,club_id,
  leave_pending,is_sitting_out,is_away,time_bank_remaining,
  time_bank_uses_remaining)
VALUES (
  'f6000000-0000-0000-0000-000000000001',
  'f5000000-0000-0000-0000-000000000001',1,
  'f1000000-0000-0000-0000-000000000001',10,'active',
  clock_timestamp()-interval '1 minute',NULL,
  'f2000000-0000-0000-0000-000000000002',
  false,false,false,30,4);

INSERT INTO public.tournament_escrow(
  tournament_id,enforced,opened_from,opened_at,updated_at)
VALUES (
  'f3000000-0000-0000-0000-000000000002',true,
  'unraked-addon-semantic-probe',clock_timestamp(),clock_timestamp());

SET LOCAL session_replication_role = origin;
SELECT set_config(
  'request.jwt.claim.sub','f1000000-0000-0000-0000-000000000001',true);
SELECT set_config('request.jwt.claim.role','service_role',true);

DO $fee_quotes$
DECLARE
  v_actual numeric[];
  v_addon record;
BEGIN
  SELECT array_agg(s.refund_fee ORDER BY quoted.gross)
    INTO v_actual
    FROM (VALUES (1::numeric),(5::numeric),(15::numeric),(20::numeric))
      AS quoted(gross)
    CROSS JOIN LATERAL public.fn_ca_tournament_charge_split(
      'f3000000-0000-0000-0000-000000000001',
      'rebuy',quoted.gross) s;
  IF v_actual IS DISTINCT FROM ARRAY[0.10,0.50,1.50,2.00]::numeric[] THEN
    RAISE EXCEPTION
      'FAIL fractional fee quotes: expected {0.10,0.50,1.50,2.00}, got %',
      v_actual;
  END IF;

  SELECT * INTO v_addon
    FROM public.fn_ca_tournament_charge_split(
      'f3000000-0000-0000-0000-000000000001','addon',15);
  IF v_addon.refund_prize IS DISTINCT FROM 15::numeric
     OR v_addon.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_addon.refund_fee IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION
      'FAIL add-on split is not exactly 15 prize + 0 bounty + 0 fee: %',
      row_to_json(v_addon);
  END IF;
END;
$fee_quotes$;

DO $bounty_rebuy$
DECLARE
  v_result jsonb;
  v_entitlement public.tournament_refund_entitlements%ROWTYPE;
  v_escrow public.tournament_escrow%ROWTYPE;
  v_read_model record;
  v_count bigint;
BEGIN
  v_result:=public.fn_ca_process_tournament_chip_purchase_money_v1(
    'f3000000-0000-0000-0000-000000000001',
    'f1000000-0000-0000-0000-000000000001',
    'rebuy',15,100,1,'fractional-rebuy-15-v1');

  IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE
     OR (v_result->>'cost')::numeric IS DISTINCT FROM 15::numeric
     OR (v_result->>'fee')::numeric IS DISTINCT FROM 1.50::numeric
     OR (v_result->>'bounty_head_funded')::numeric
          IS DISTINCT FROM 1.50::numeric
     OR (v_result->>'chips_added')::numeric IS DISTINCT FROM 100::numeric THEN
    RAISE EXCEPTION 'FAIL private rebuy core returned the wrong split: %',v_result;
  END IF;

  SELECT count(*),min(e.id::text)::uuid
    INTO v_count,v_entitlement.id
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id='f3000000-0000-0000-0000-000000000001'
     AND e.user_id='f1000000-0000-0000-0000-000000000001'
     AND e.entitlement_kind='wallet_charge'
     AND e.charge_category='rebuy';
  IF v_count<>1 OR v_entitlement.id IS NULL THEN
    RAISE EXCEPTION 'FAIL rebuy did not capture exactly one refund entitlement';
  END IF;
  SELECT * INTO v_entitlement
    FROM public.tournament_refund_entitlements e
   WHERE e.id=v_entitlement.id;
  IF v_entitlement.gross IS DISTINCT FROM 15::numeric
     OR v_entitlement.refund_prize IS DISTINCT FROM 12::numeric
     OR v_entitlement.refund_bounty IS DISTINCT FROM 1.50::numeric
     OR v_entitlement.refund_fee IS DISTINCT FROM 1.50::numeric
     OR v_entitlement.refund_wallet_club_id IS DISTINCT FROM
          'f2000000-0000-0000-0000-000000000002'::uuid
     OR v_entitlement.evidence_kind IS DISTINCT FROM 'atomic_wallet_charge'
     OR NOT EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.id=v_entitlement.source_ledger_id
          AND l.from_type='player_wallet'
          AND l.from_entity_id=
                'f1000000-0000-0000-0000-000000000001'::uuid
          AND l.to_type='prize_liability'
          AND l.to_entity_id=
                'f3000000-0000-0000-0000-000000000001'::uuid
          AND l.club_id=
                'f2000000-0000-0000-0000-000000000002'::uuid
          AND l.amount=15 AND l.category='rebuy' AND l.status='posted')
     OR NOT EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id=
                'f3000000-0000-0000-0000-000000000001'::uuid
          AND r.club_id=
                'f2000000-0000-0000-0000-000000000001'::uuid
          AND r.rake_amount=1.50
          AND r.rake_amount>0
          AND r.source='process_tournament_rebuy'
          AND r.metadata->>'kind'='tournament_rebuy_fee') THEN
    RAISE EXCEPTION
      'FAIL immutable rebuy refund split or source journal is wrong: %',
      row_to_json(v_entitlement);
  END IF;

  SELECT * INTO v_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id='f3000000-0000-0000-0000-000000000001';
  IF v_escrow.gross_in IS DISTINCT FROM 15::numeric
     OR v_escrow.fee_entries_in IS DISTINCT FROM 1.50::numeric
     OR v_escrow.bounty_in IS DISTINCT FROM 1.50::numeric
     OR v_escrow.prize_balance IS DISTINCT FROM 12::numeric
     OR v_escrow.bounty_balance IS DISTINCT FROM 1.50::numeric
     OR v_escrow.fee_balance IS DISTINCT FROM 1.50::numeric THEN
    RAISE EXCEPTION 'FAIL physical rebuy escrow split is wrong: %',
      row_to_json(v_escrow);
  END IF;

  SELECT * INTO v_read_model
    FROM public.fn_ca_tournament_escrow(
      'f3000000-0000-0000-0000-000000000001');
  IF v_read_model.prize_in IS DISTINCT FROM 12::numeric
     OR v_read_model.bounty_in IS DISTINCT FROM 1.50::numeric
     OR v_read_model.fee_in IS DISTINCT FROM 1.50::numeric
     OR v_read_model.prize_balance IS DISTINCT FROM 12::numeric
     OR v_read_model.bounty_balance IS DISTINCT FROM 1.50::numeric
     OR v_read_model.fee_balance IS DISTINCT FROM 1.50::numeric THEN
    RAISE EXCEPTION 'FAIL derived rebuy escrow split is wrong: %',
      row_to_json(v_read_model);
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id='f3000000-0000-0000-0000-000000000001'
          AND t.prize_pool=12 AND t.bounty_pool=1.50 AND t.total_rake=1.50)
     OR NOT EXISTS (
       SELECT 1 FROM public.club_members cm
        WHERE cm.club_id='f2000000-0000-0000-0000-000000000002'
          AND cm.user_id='f1000000-0000-0000-0000-000000000001'
          AND cm.chip_balance=85)
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id='f3000000-0000-0000-0000-000000000001'
          AND tp.user_id='f1000000-0000-0000-0000-000000000001'
          AND tp.chips=100 AND tp.rebuys=1 AND tp.current_bounty=1.50)
     OR (SELECT count(*) FROM public.rake_records r
          WHERE r.tournament_id='f3000000-0000-0000-0000-000000000001'
            AND r.club_id='f2000000-0000-0000-0000-000000000001'
            AND r.rake_amount=1.50
            AND r.rake_amount>0
            AND r.source='process_tournament_rebuy'
            AND r.metadata->>'kind'='tournament_rebuy_fee')<>1
     OR (SELECT count(*) FROM public.wallet_transactions w
          WHERE w.related_entity_id=
                'f3000000-0000-0000-0000-000000000001'
            AND w.user_id='f1000000-0000-0000-0000-000000000001'
            AND w.type='debit' AND w.category='rebuy'
            AND w.amount=15 AND w.balance_after=85)<>1 THEN
    RAISE EXCEPTION
      'FAIL rebuy did not conserve wallet, roster, prize, bounty and fee books';
  END IF;
END;
$bounty_rebuy$;

DO $unraked_addon$
DECLARE
  v_result jsonb;
  v_entitlement public.tournament_refund_entitlements%ROWTYPE;
  v_escrow public.tournament_escrow%ROWTYPE;
  v_read_model record;
BEGIN
  v_result:=public.fn_ca_process_tournament_chip_purchase_money_v1(
    'f3000000-0000-0000-0000-000000000002',
    'f1000000-0000-0000-0000-000000000001',
    'addon',15,100,1,'unraked-addon-15-v1');
  IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE
     OR (v_result->>'cost')::numeric IS DISTINCT FROM 15::numeric
     OR (v_result->>'fee')::numeric IS DISTINCT FROM 0::numeric
     OR (v_result->>'bounty_head_funded')::numeric IS DISTINCT FROM 0::numeric
     OR COALESCE((v_result->>'seated')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL private add-on core charged rake or bounty: %',v_result;
  END IF;

  SELECT * INTO v_entitlement
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id='f3000000-0000-0000-0000-000000000002'
     AND e.user_id='f1000000-0000-0000-0000-000000000001'
     AND e.entitlement_kind='wallet_charge'
     AND e.charge_category='addon';
  IF NOT FOUND OR v_entitlement.gross IS DISTINCT FROM 15::numeric
     OR v_entitlement.refund_prize IS DISTINCT FROM 15::numeric
     OR v_entitlement.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_entitlement.refund_fee IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'FAIL immutable add-on refund split is not unraked: %',
      row_to_json(v_entitlement);
  END IF;

  SELECT * INTO v_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id='f3000000-0000-0000-0000-000000000002';
  SELECT * INTO v_read_model
    FROM public.fn_ca_tournament_escrow(
      'f3000000-0000-0000-0000-000000000002');
  IF v_escrow.gross_in IS DISTINCT FROM 15::numeric
     OR v_escrow.fee_entries_in IS DISTINCT FROM 0::numeric
     OR v_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_escrow.prize_balance IS DISTINCT FROM 15::numeric
     OR v_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_escrow.fee_balance IS DISTINCT FROM 0::numeric
     OR v_read_model.prize_in IS DISTINCT FROM 15::numeric
     OR v_read_model.bounty_in IS DISTINCT FROM 0::numeric
     OR v_read_model.fee_in IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'FAIL add-on escrow is not exactly unraked: physical %, derived %',
      row_to_json(v_escrow),row_to_json(v_read_model);
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id='f3000000-0000-0000-0000-000000000002'
          AND t.prize_pool=15 AND t.bounty_pool=0 AND t.total_rake=0)
     OR NOT EXISTS (
       SELECT 1 FROM public.club_members cm
        WHERE cm.club_id='f2000000-0000-0000-0000-000000000002'
          AND cm.user_id='f1000000-0000-0000-0000-000000000001'
          AND cm.chip_balance=70)
     OR NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.id='f6000000-0000-0000-0000-000000000001'
          AND s.stack=110 AND s.left_at IS NULL)
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id='f3000000-0000-0000-0000-000000000002'
          AND tp.user_id='f1000000-0000-0000-0000-000000000001'
          AND tp.chips=110 AND tp.add_on)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id='f3000000-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION
      'FAIL add-on did not conserve its unraked wallet, seat and prize books';
  END IF;
END;
$unraked_addon$;

ROLLBACK;

SELECT 'PASS fractional rebuy and add-on split semantic probe' AS result;
