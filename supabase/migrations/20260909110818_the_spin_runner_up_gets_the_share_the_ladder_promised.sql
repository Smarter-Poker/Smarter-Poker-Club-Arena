DO $mig$
DECLARE
  c_tid   uuid := '6d688095-c3c5-4d40-a5a0-952934667732';  -- 1 Chip Deep Stack Spin PLO5
  c_second uuid := 'bbcaaed4-92b3-4ad7-86ee-7770bb36751a'; -- place 2
  c_union uuid := 'fade0000-0000-0000-0000-000000000001';
  v_mig   text := to_char(now() AT TIME ZONE 'utc','YYYYMMDDHH24MISS')
                  || '_the_spin_runner_up_gets_the_share_the_ladder_promised';
  v_adj   uuid;
  v_res   jsonb;
  v_bal   numeric;
  v_p1    record;
  v_p2    record;
BEGIN
  /* WHAT HAPPENED. This spin drew a 10x multiplier: 2.76 of entry money went
     to the reserve and the reserve paid 10.00 back, so the event held exactly
     10.00 for prizes. The ladder for a 10x spin pays 80/20, which is 8.00 to
     first and 2.00 to second, and the event recorded that structure.

     Three paths then paid it, each reading a different pool:
       12:41  the engine paid first place 3.00 - the whole UNSPUN pool, as if
              a spin were winner-take-all and the multiplier had not landed.
       12:52  the reconciler paid second place 0.60 - correctly 20 percent,
              but of the unspun 3.00 rather than the 10.00 actually drawn.
       13:06  the spin back-pay topped first place up toward the whole 10.00
              draw, and the escrow - already 0.60 lighter - capped it at 6.40.

     First place took 9.40 where the ladder promised 8.00. Second place took
     0.60 where the ladder promised 2.00. The event conserved perfectly: 10.00
     in, 10.00 out. It was split wrong.

     BOTH CODE PATHS ARE ALREADY FIXED, two days after this event settled:
     migration 20260908002718 taught the back-pay to cap first place at its
     share of the recorded draw, and 20260908000459 corrected what the
     reconciler settles. Of the 318 completed spins whose ladder pays more
     than one place, this is the only one that split wrong. So this migration
     carries no code - only the money and the record.

     THE RULING (CLAUDE.md 10.9). Second place is paid the 1.40 the ladder
     promised them. First place keeps the 1.40 they were overpaid: they were
     credited in good faith by the platform's own settlement path, the error
     was ours, and this platform does not reach into a player wallet to
     correct its own arithmetic. The 1.40 is funded by the union bank - the
     same house that took this event 0.24 of rake - as an overlay, which is
     the instrument for the house putting chips into an event it under-funded.

     WHY FIRST PLACE'S ROW READS 9.40 AND NOT THE LADDER'S 8.00. A CHECK
     constraint on tournament_obligations forbids amount_paid above
     amount_owed, and that invariant is right: the column records the ceiling
     the platform has committed to, never a number below what a player has
     already been handed. So the row is brought down from the 10.00 the
     pre-fix back-pay asserted to the 9.40 that was actually paid, which
     closes the phantom 0.60 the platform believed it still owed and would
     have gone on trying to pay out of an empty escrow. The ladder figure of
     8.00 is recorded here and in the incident, where it can be stated
     without lying about what was paid. */

  ------------------------------------------------------------------
  -- 0. The facts this migration asserts must still be the facts.
  ------------------------------------------------------------------
  SELECT prize_balance INTO v_bal FROM public.tournament_escrow WHERE tournament_id = c_tid;
  IF v_bal IS DISTINCT FROM 0.00 THEN
    RAISE EXCEPTION 'the escrow no longer reads 0.00, it reads %', v_bal;
  END IF;
  SELECT amount_owed, amount_paid INTO v_p1 FROM public.tournament_obligations
   WHERE tournament_id = c_tid AND kind = 'place' AND place = 1;
  IF v_p1.amount_owed <> 10.00 OR v_p1.amount_paid <> 9.40 THEN
    RAISE EXCEPTION 'place 1 no longer reads owed 10.00 paid 9.40; it reads owed % paid %',
      v_p1.amount_owed, v_p1.amount_paid;
  END IF;
  SELECT amount_owed, amount_paid INTO v_p2 FROM public.tournament_obligations
   WHERE tournament_id = c_tid AND kind = 'place' AND place = 2;
  IF v_p2.amount_paid <> 0.60 THEN
    RAISE EXCEPTION 'place 2 no longer reads paid 0.60; it reads %', v_p2.amount_paid;
  END IF;

  ------------------------------------------------------------------
  -- 1. The house funds what it under-paid.
  ------------------------------------------------------------------
  SELECT chip_balance INTO v_bal FROM public.union_wallets WHERE union_id = c_union FOR UPDATE;
  IF COALESCE(v_bal, 0) < 1.40 THEN
    RAISE EXCEPTION 'the union bank holds % and cannot fund a 1.40 overlay', COALESCE(v_bal,0);
  END IF;

  PERFORM public.fn_ca_declare_ledger('overlay', 'prize_liability', c_tid, NULL,
    'spin-ladder-overlay:' || c_tid::text, NULL);
  UPDATE public.union_wallets SET chip_balance = chip_balance - 1.40, updated_at = now()
   WHERE union_id = c_union;

  PERFORM public.fn_ca_escrow_apply(c_tid,
    'overlay from the union bank: the 10x ladder owed second place 2.00 and the event paid 0.60',
    0, 0, 0, 0, 1.40, 0, 0, 0, 0, 0, 0, 0);

  ------------------------------------------------------------------
  -- 2. Second place is paid, through the one settlement door.
  ------------------------------------------------------------------
  v_adj := public.fn_ca_adjustment_under_10_9(
    c_tid, c_second, 2.00,
    'Migration ' || v_mig || ': the 10x spin ladder recorded on this event pays 80/20 and the '
    || 'event held exactly 10.00 for prizes, which is 8.00 to first place and 2.00 to second. '
    || 'Second place was paid 0.60 - twenty percent of the 3.00 UNSPUN pool - because the '
    || 'reconciler read the pool before the multiplier landed. First place was paid 9.40. The '
    || 'event conserved: 10.00 in, 10.00 out, split wrong. This authorises second place to be '
    || 'settled to their full 2.00 entitlement, of which 1.40 moves, funded by an overlay from '
    || 'the union bank that took this event rake. First place keeps their 1.40 overpayment: it '
    || 'was credited in good faith by the platform own settlement path and we do not claw back '
    || 'our own arithmetic. Both code paths were fixed on 2026-09-08 and no other spin split wrong.',
    v_mig, 'chip standard 10.9 (Claude)');

  v_res := public.fn_settle_tournament_obligation(
    c_tid, 'place', 2, c_second, 2.00, 'reconcile',
    'Spin ladder correction: the 10x ladder pays second place 20 percent of the drawn prize',
    v_adj);

  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE
     OR round(COALESCE((v_res->>'paid')::numeric, 0), 2) <> 1.40 THEN
    RAISE EXCEPTION 'second place was not paid their 1.40: %', v_res;
  END IF;

  ------------------------------------------------------------------
  -- 3. First place's row stops claiming an outstanding 0.60.
  ------------------------------------------------------------------
  UPDATE public.tournament_obligations
     SET amount_owed = 9.40, updated_at = now(), settled_at = COALESCE(settled_at, now())
   WHERE tournament_id = c_tid AND kind = 'place' AND place = 1;

  ------------------------------------------------------------------
  -- 4. Assertions.
  ------------------------------------------------------------------
  SELECT prize_balance INTO v_bal FROM public.tournament_escrow WHERE tournament_id = c_tid;
  IF round(COALESCE(v_bal,0), 2) <> 0.00 THEN
    RAISE EXCEPTION 'the escrow should be empty again and reads %', v_bal;
  END IF;
  SELECT amount_owed, amount_paid INTO v_p2 FROM public.tournament_obligations
   WHERE tournament_id = c_tid AND kind = 'place' AND place = 2;
  IF v_p2.amount_owed <> 2.00 OR v_p2.amount_paid <> 2.00 THEN
    RAISE EXCEPTION 'place 2 should read owed 2.00 paid 2.00 and reads owed % paid %',
      v_p2.amount_owed, v_p2.amount_paid;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_obligations
              WHERE tournament_id = c_tid AND amount_paid < amount_owed) THEN
    RAISE EXCEPTION 'this event still shows an outstanding obligation';
  END IF;
  IF (SELECT count(*) FROM public.chip_ledger
       WHERE tournament_id = c_tid AND category = 'overlay' AND amount = 1.40) <> 1 THEN
    RAISE EXCEPTION 'the overlay leg was not written exactly once';
  END IF;
END
$mig$;;
