-- Disposable database only. Proves a tournament buy-in debits the hosting
-- club rather than an older membership, and invalid/mismatched requests move
-- no money. The PASS exception rolls every fixture row back.
BEGIN;

DO $fixture_guard$
BEGIN
  IF current_user<>'postgres'
     OR to_regprocedure(
       'public.atomic_deduct_wallet_and_log(uuid,numeric,text,text,uuid,uuid,uuid)'
     ) IS NULL THEN
    RAISE EXCEPTION 'wallet debit probe requires a disposable rehearsal database';
  END IF;
END;
$fixture_guard$;

SET LOCAL session_replication_role=replica;

INSERT INTO auth.users(id)
VALUES ('93000000-0000-4000-8000-000000000001');
INSERT INTO public.profiles(id,username,display_name)
VALUES ('93000000-0000-4000-8000-000000000001','wallet_context','Wallet Context');
INSERT INTO public.clubs(id,name,owner_id,chip_treasury)
VALUES
  ('93000000-0000-4000-8000-000000000002','Older Club',
   '93000000-0000-4000-8000-000000000001',1000),
  ('93000000-0000-4000-8000-000000000003','Tournament Club',
   '93000000-0000-4000-8000-000000000001',1000);
INSERT INTO public.club_members(
  club_id,user_id,role,status,chip_balance,joined_at
) VALUES
  ('93000000-0000-4000-8000-000000000002',
   '93000000-0000-4000-8000-000000000001','player','active',100,
   now()-interval '1 day'),
  ('93000000-0000-4000-8000-000000000003',
   '93000000-0000-4000-8000-000000000001','player','active',100,now());
INSERT INTO public.tournaments(
  id,club_id,name,buy_in_amount,buy_in_fee,start_time,status,current_players,
  max_players,min_players,starting_chips,prize_pool
) VALUES (
  '93000000-0000-4000-8000-000000000004',
  '93000000-0000-4000-8000-000000000003','Wallet Context MTT',
  10,0,now()+interval '1 hour','REGISTERING',0,9,2,1000,0
);

SET LOCAL session_replication_role=origin;

DO $proof$
DECLARE v_ok boolean; v_state text;
BEGIN
  BEGIN
    PERFORM public.atomic_deduct_wallet_and_log(
      '93000000-0000-4000-8000-000000000001',-10,'tournament_buyin',
      'negative control',NULL,NULL,
      '93000000-0000-4000-8000-000000000004');
  EXCEPTION WHEN SQLSTATE '22023' THEN v_state:='negative_refused';
  END;
  IF v_state IS DISTINCT FROM 'negative_refused' THEN
    RAISE EXCEPTION 'FAIL negative wallet debit was accepted';
  END IF;

  PERFORM set_config(
    'app.ledger_club_id','93000000-0000-4000-8000-000000000002',true);
  v_state:=NULL;
  BEGIN
    PERFORM public.atomic_deduct_wallet_and_log(
      '93000000-0000-4000-8000-000000000001',10,'tournament_buyin',
      'mismatch control',NULL,NULL,
      '93000000-0000-4000-8000-000000000004');
  EXCEPTION WHEN SQLSTATE '22023' THEN v_state:='mismatch_refused';
  END;
  IF v_state IS DISTINCT FROM 'mismatch_refused' THEN
    RAISE EXCEPTION 'FAIL mismatched declared club was accepted';
  END IF;

  PERFORM set_config('app.ledger_club_id','',true);
  v_ok:=public.atomic_deduct_wallet_and_log(
    '93000000-0000-4000-8000-000000000001',10,'tournament_buyin',
    'context proof',NULL,NULL,
    '93000000-0000-4000-8000-000000000004');
  IF v_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL exact tournament wallet debit returned %',v_ok;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.club_id='93000000-0000-4000-8000-000000000002'
       AND cm.user_id='93000000-0000-4000-8000-000000000001'
       AND cm.chip_balance=100
  ) OR NOT EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.club_id='93000000-0000-4000-8000-000000000003'
       AND cm.user_id='93000000-0000-4000-8000-000000000001'
       AND cm.chip_balance=90
  ) OR (SELECT count(*) FROM public.chip_transactions ct
        WHERE ct.club_id='93000000-0000-4000-8000-000000000003'
          AND ct.from_user_id='93000000-0000-4000-8000-000000000001'
          AND ct.amount=10 AND ct.transaction_type='tournament_buyin')<>1 THEN
    RAISE EXCEPTION 'FAIL tournament debit did not move exactly 10 from its hosting club';
  END IF;
END;
$proof$;

DO $pass$
BEGIN
  RAISE EXCEPTION
    'AUDIT_TEST_PASS: tournament debit used its hosting club, rejected negative and mismatched context, and moved one exact chip transaction; all probe work rolled back';
END;
$pass$;
