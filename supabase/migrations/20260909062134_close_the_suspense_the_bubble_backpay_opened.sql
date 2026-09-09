-- CLOSE THE SUSPENSE THE BUBBLE BACK-PAY OPENED (2026-09-09)
--
-- Migration 20260909061500 funded two bubble-protection back-pays by debiting
-- the host banks directly and then publishing an explicit `correction` leg
-- (club_treasury/union_bank -> prize_liability) for the escrow trigger to read.
-- The explicit legs are right and the escrow credited exactly once.
--
-- What was missed: the auto-ledger watches balance columns, and a bare UPDATE
-- to clubs.chip_treasury / union_wallets.rake_wallet produces its own twin row.
-- With no `app.ledger_category` declared, those twins were booked to
-- settlement_suspense:
--
--   club_treasury 2a1132b9 -> settlement_suspense  180.00  auto-ledgered ...
--   union_wallet  059bb325 -> settlement_suspense  180.00  auto-ledgered ...
--
-- So each 180.00 is journalled TWICE - once correctly to the prize escrow, once
-- spuriously to suspense - while each bank balance moved only once.
-- fn_ca_suspense_regression_check caught it within twelve minutes, which is the
-- detector doing exactly its job.
--
-- chip_ledger is append-only, so the twins cannot be deleted. They are
-- cancelled forward, which is the house rule anyway: two compensating entries
-- returning 180.00 each from settlement_suspense to the bank it came from.
-- Net effect on the journal: each bank reads -180.00 (the real movement, from
-- the explicit correction leg) and settlement_suspense returns to zero.
--
-- No balance moves. chip_ledger has no balance-moving insert trigger - verified
-- against all eleven of its triggers - and neither compensating row can reach
-- zz_ca_escrow_overlay_leg, which fires only on to_type = 'prize_liability'.
--
-- THE REAL LESSON, for the next money correction: fn_ca_apply_prize_guarantee_core
-- sets app.ledger_category / app.ledger_counterparty / app.ledger_counterparty_entity
-- around its bank debit precisely so the auto-ledger twin is classified instead
-- of landing in suspense. A direct balance UPDATE on a money path must do the
-- same. That is now written into the changelog beside this.
--
-- ROLLBACK: two further compensating rows in the opposite direction. Nothing
-- here changes a balance, so there is nothing to unwind.

BEGIN;
SET LOCAL lock_timeout = '4s';

DO $mig$
DECLARE
  v_club  CONSTANT uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_uw    CONSTANT uuid := '059bb325-6eeb-4bbd-957d-3a82e755bb0c';
  v_twins int;
BEGIN
  SELECT count(*) INTO v_twins FROM public.chip_ledger
   WHERE to_type = 'settlement_suspense'
     AND description LIKE 'auto-ledgered%'
     AND amount = 180.00
     AND created_at > now() - interval '6 hours';
  IF v_twins <> 2 THEN
    RAISE EXCEPTION 'expected exactly 2 auto-ledger suspense twins of 180.00, found %', v_twins;
  END IF;

  INSERT INTO public.chip_ledger (performed_by, from_type, from_entity_id, to_type, to_entity_id,
      amount, category, club_id, idempotency_key, description)
  VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d','settlement_suspense', NULL,
      'club_treasury', v_club, 180.00, 'correction', v_club,
      'correction:bubble_backpay:suspense_close:club',
      'Cancels The Auto Ledger Twin Of The Bubble Protection Back Pay Bank Debit');

  INSERT INTO public.chip_ledger (performed_by, from_type, from_entity_id, to_type, to_entity_id,
      amount, category, union_id, idempotency_key, description)
  VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d','settlement_suspense', NULL,
      'union_wallet', v_uw, 180.00, 'correction', 'fade0000-0000-0000-0000-000000000001',
      'correction:bubble_backpay:suspense_close:union',
      'Cancels The Auto Ledger Twin Of The Bubble Protection Back Pay Bank Debit');
END $mig$;

DO $post$
DECLARE v_net numeric;
BEGIN
  SELECT COALESCE(sum(CASE WHEN to_type='settlement_suspense' THEN amount
                           WHEN from_type='settlement_suspense' THEN -amount END),0)
    INTO v_net
    FROM public.chip_ledger
   WHERE (to_type='settlement_suspense' OR from_type='settlement_suspense')
     AND created_at > now() - interval '6 hours';
  IF round(v_net,2) <> 0 THEN
    RAISE EXCEPTION 'settlement_suspense did not return to zero for this window: %', v_net;
  END IF;
END $post$;

COMMIT;
