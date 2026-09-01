-- Remove the financial effect of the horse-only Spins created in Deep Stack
-- Society before user-owned boards were prohibited from automated liquidity.
-- The opening grant was 100,000. The only valid setup debits are 1,000 BBJ
-- and 500 leaderboard seed, so the certified bank balance is 98,500.

CREATE TABLE IF NOT EXISTS public.club_financial_quarantine (
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  club_id uuid NOT NULL,
  reason text NOT NULL,
  row_data jsonb NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, source_id)
);
ALTER TABLE public.club_financial_quarantine ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_financial_quarantine FROM PUBLIC, anon, authenticated;

DO $repair$
DECLARE
  v_club constant uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_bank numeric;
  v_pool numeric;
  v_bad_rake numeric;
  v_bad_returns numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clubs WHERE id=v_club) THEN RETURN; END IF;

  SELECT chip_treasury INTO v_bank FROM public.clubs WHERE id=v_club FOR UPDATE;
  SELECT balance INTO v_pool FROM public.spin_bonus_pools WHERE club_id=v_club FOR UPDATE;
  SELECT COALESCE(sum(rake_amount),0) INTO v_bad_rake
    FROM public.rake_records
   WHERE club_id=v_club AND source='fn_spin_settle_game';
  SELECT COALESCE(sum(amount),0) INTO v_bad_returns
   FROM public.chip_ledger
   WHERE club_id=v_club
     AND from_type='settlement_suspense' AND to_type='club_treasury'
     AND created_at >= '2026-08-31 23:56:00+00'::timestamptz
     AND created_at <  '2026-09-01 00:06:00+00'::timestamptz;

  IF v_bank = 98500 AND COALESCE(v_pool,0)=0 THEN RETURN; END IF;
  IF v_bank <> 103950.80 OR v_pool <> 873.20 OR v_bad_rake <> 574.80
     OR v_bad_returns <> 4876 THEN
    RAISE EXCEPTION 'Deep Stack Correction Guard Failed: bank %, pool %, rake %, returns %',
      v_bank,v_pool,v_bad_rake,v_bad_returns;
  END IF;

  INSERT INTO public.club_financial_quarantine
    (source_table,source_id,club_id,reason,row_data)
  SELECT 'rake_records',r.id,v_club,
         'Horse-Only Spins Created Before User-Club Liquidity Guard',to_jsonb(r)
    FROM public.rake_records r
   WHERE r.club_id=v_club AND r.source='fn_spin_settle_game'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.club_financial_quarantine
    (source_table,source_id,club_id,reason,row_data)
  SELECT 'spin_reserve_ledger',s.id,v_club,
         'Horse-Only Spins Created Before User-Club Liquidity Guard',to_jsonb(s)
    FROM public.spin_reserve_ledger s
   WHERE s.club_id=v_club AND s.kind IN ('contribution','jackpot_draw')
  ON CONFLICT DO NOTHING;

  -- The source rows remain append-only evidence. Club financial readers exclude
  -- rows present in club_financial_quarantine; no destructive ledger rewrite is
  -- used to make the correction balance.
  DELETE FROM public.spin_reserve_ledger
   WHERE club_id=v_club AND kind IN ('contribution','jackpot_draw');

  PERFORM set_config('app.ledger_category','correction',true);
  PERFORM set_config('app.ledger_counterparty','chip_retirement',true);
  PERFORM set_config('app.ledger_counterparty_entity','',true);
  UPDATE public.clubs SET chip_treasury=98500 WHERE id=v_club;

  INSERT INTO public.club_wallet_transactions
    (club_id,type,amount,balance_after,reason)
  VALUES (v_club,'correction',-5450.80,98500,
          'Remove Invalid Automated Opening-Club Activity')
  ON CONFLICT DO NOTHING;

  PERFORM set_config('app.ledger_category','correction',true);
  PERFORM set_config('app.ledger_counterparty','chip_retirement',true);
  PERFORM set_config('app.ledger_counterparty_entity','',true);
  UPDATE public.spin_bonus_pools
     SET balance=0,total_deposited=0,total_drawn=0,spin_count=0,bonus_count=0,
         highest_stake=0,surplus_returned=0,updated_at=now()
   WHERE club_id=v_club;

  INSERT INTO public.spin_reserve_ledger
    (club_id,kind,amount,balance_after,note)
  VALUES (v_club,'adjustment',-873.20,0,
          'Quarantined Horse-Only Spin Activity From New-Club Incident');
END;
$repair$;

DO $verify$
DECLARE v_club constant uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
BEGIN
  IF EXISTS (SELECT 1 FROM public.clubs WHERE id=v_club AND chip_treasury<>98500)
     OR EXISTS (SELECT 1 FROM public.spin_bonus_pools WHERE club_id=v_club AND
       (balance<>0 OR total_deposited<>0 OR total_drawn<>0 OR spin_count<>0 OR bonus_count<>0))
     OR (SELECT count(*) FROM public.club_financial_quarantine
          WHERE club_id=v_club AND source_table='rake_records')<>112
     OR (SELECT count(*) FROM public.club_members WHERE club_id=v_club)<>1
  THEN RAISE EXCEPTION 'Deep Stack Opening-Balance Postcondition Failed'; END IF;
END;
$verify$;
