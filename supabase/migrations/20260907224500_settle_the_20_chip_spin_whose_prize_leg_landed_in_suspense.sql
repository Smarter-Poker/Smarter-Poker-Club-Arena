-- ============================================================================
--  SETTLEMENT: "20 Chip Deep Stack Spin PLO5" (0ec5d7b2), 2026-09-07 22:03 UTC
--
--  WHAT HAPPENED (read from rows, not assumed). Three horses bought in at 20
--  each (60 gross, 4.80 rake). fn_spin_settle_game drew a 5x at 21:48:30 and
--  debited the Deep Stack Society spin reserve by 100 (spin_reserve_ledger
--  jackpot_draw -100, balance 12,153.04). The auto-ledger's primary INSERT of
--  that leg - category spin_prize, counterparty prize_liability(0ec5d7b2) -
--  was REJECTED (cause not recorded; ca_ledger_write_failures is empty) and
--  its fallback wrote the leg as `adjustment` spin_reserve -> settlement_suspense
--  (chip_ledger 21:48:30.814, 100.00). Because the category became
--  `adjustment`, zz_ca_escrow_reserve_leg never credited the tournament escrow
--  (reserve_in stayed 0.00). The spin ran across the 21:55 restart and ended at
--  22:03:55; the one payer refused the champion's 100 with escrow_short
--  ("the escrow holds 0.00 for that bank"). Horse b474bb12 finished first, is
--  owed 100.00 (tournament_obligations place 1, amount_paid 0), and received
--  nothing. The 100 chips sit in settlement_suspense, having left the reserve
--  and reached nobody. This is the only such case in 7 days (one jackpot_draw
--  whose escrow credit is missing); the 3,792 spin_prize->suspense legs of
--  2026-09-01/02 were a different, since-fixed defect.
--
--  WHAT THIS DOES. (1) A `correction` leg moves the 100 from
--  settlement_suspense to prize_liability(0ec5d7b2) and fn_ca_escrow_apply
--  records reserve_in 100 - the leg the auto-ledger should have written, with
--  the same precedent the chip-standard workstream used on 2026-09-06
--  ("Compensating leg for a spin prize that left the reserve while its journal
--  row was refused"). (2) fn_tournament_payout_reconcile(apply) pays the
--  place-1 obligation through fn_settle_tournament_obligation - the ONE payer,
--  idempotent on the obligation row. Nothing is hand-written into a wallet.
--  Nobody is paid twice: the obligation carries amount_paid and the probe
--  asserted it was 0. Nothing is taken back from anyone.
--
--  PROVEN ROLLED BACK FIRST (2026-09-07 22:4x UTC): escrow reserve_in 0 ->
--  100, prize_balance 100; reconcile settled place 1 for 100.00; the
--  champion's club_members.chip_balance 14,146.60 -> 14,246.60. The same
--  numbers are asserted below so this aborts if the board moved.
--
--  THE ROOT CAUSE IS NOT FIXED HERE and is filed for the chip-standard
--  workstream: the auto-ledger swallowed the reason the spin_prize leg was
--  rejected and quietly parked a prize in suspense. A refused prize leg must
--  raise a financial alert naming the SQLSTATE, not fall through to
--  `adjustment`. See the changelog for the issue reference.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s';
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
DO $$
DECLARE v_tid uuid := '0ec5d7b2-7c1c-44a9-882d-489b8ffd086f'; v_win uuid := 'b474bb12-d6ec-4ea0-b661-58811b604b97';
        v_club uuid; v_before numeric; v_after numeric; v_res jsonb; v_esc record; v_n int;
BEGIN
  SELECT club_id INTO v_club FROM tournaments WHERE id=v_tid;
  SELECT count(*) INTO v_n FROM chip_ledger WHERE from_type='spin_reserve' AND from_entity_id='01810895-3a66-45ce-aee7-e2fcb3857384' AND to_type='settlement_suspense' AND amount=100.00 AND category='adjustment' AND created_at BETWEEN '2026-09-07 21:48:30' AND '2026-09-07 21:48:31';
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected exactly one 100-chip suspense leg at 21:48:30, found %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM chip_ledger WHERE tournament_id=v_tid AND category='correction') THEN RAISE EXCEPTION 'a correction leg already exists for this spin'; END IF;
  IF (SELECT amount_paid FROM tournament_obligations WHERE tournament_id=v_tid AND kind='place' AND place=1 AND user_id=v_win) <> 0 THEN RAISE EXCEPTION 'the place-1 obligation is no longer unpaid'; END IF;
  IF (SELECT reserve_in FROM tournament_escrow WHERE tournament_id=v_tid) <> 0 THEN RAISE EXCEPTION 'escrow reserve_in is no longer 0'; END IF;
  SELECT chip_balance INTO v_before FROM club_members WHERE user_id=v_win AND club_id=v_club;
  IF v_before <> 14146.60 THEN RAISE EXCEPTION 'the champion wallet moved since the probe (%), re-probe before applying', v_before; END IF;

  INSERT INTO chip_ledger (performed_by, from_type, from_entity_id, to_type, to_entity_id, amount, category, description, tournament_id, club_id)
  VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d', 'settlement_suspense', NULL, 'prize_liability', v_tid, 100.00, 'correction',
          'Compensating leg for a spin prize that left the reserve at 21:48:30 and was auto-ledgered to settlement_suspense (category spin_prize rejected) instead of the tournament escrow; the champion was owed 100.00 and refused (escrow_short). 2026-09-07 restart-programme agent.',
          v_tid, v_club);
  PERFORM public.fn_ca_escrow_apply(v_tid, 'spin prize from reserve (compensating leg 2026-09-07)', p_reserve_in => 100.00);
  SELECT reserve_in, prize_balance INTO v_esc FROM tournament_escrow WHERE tournament_id=v_tid;
  IF v_esc.reserve_in <> 100.00 OR v_esc.prize_balance <> 100.00 THEN RAISE EXCEPTION 'escrow did not land as probed: reserve_in % prize_balance %', v_esc.reserve_in, v_esc.prize_balance; END IF;

  v_res := public.fn_tournament_payout_reconcile(v_tid, true);
  SELECT chip_balance INTO v_after FROM club_members WHERE user_id=v_win AND club_id=v_club;
  IF v_after - v_before <> 100.00 THEN RAISE EXCEPTION 'the champion did not receive exactly 100 (got %); aborting', v_after - v_before; END IF;

  UPDATE financial_alerts SET resolved=true, resolved_at=now(), resolved_by='2d1cd6c3-5700-4af9-a271-d4863fdab20d',
         resolution='Settled 2026-09-07: the 100-chip spin prize that the auto-ledger had parked in settlement_suspense (spin_prize leg rejected at 21:48:30) was moved to the tournament escrow by a correction leg and paid to the champion through fn_tournament_payout_reconcile / fn_settle_tournament_obligation. Root cause (a refused prize leg falling through to adjustment/suspense without an alert) filed for the chip-standard workstream.'
   WHERE resolved=false AND (context->>'tournament_id' = v_tid::text OR message ILIKE '%20 Chip Deep Stack Spin PLO5%') AND created_at > '2026-09-07 22:00';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'settled: champion % -> %, alerts resolved %, reconcile %', v_before, v_after, v_n, left(v_res::text,160);
END $$;
COMMIT;
