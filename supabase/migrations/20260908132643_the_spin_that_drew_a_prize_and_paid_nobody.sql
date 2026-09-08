DO $mig$
DECLARE
  v_adj uuid; v_settle jsonb;
  v_before numeric; v_after numeric; v_reserve_in numeric;
  v_reason text :=
    'Migration 20260908132643_the_spin_that_drew_a_prize_and_paid_nobody. '
    'One player is owed: pokerdale (c402b38e-7ba6-40bf-a2d3-d65376d28ccf), 3.00 chips, for winning the 1 Chip Deep Stack Spin NLH (781cc0ee-6a1d-4e31-acaf-4e737661bba1) at Midway Union on 2026-09-08 03:05. '
    'tournament_players records position 1, status winner, prize 3.00; tournament_obligations row d367f526-d950-4b4a-af4d-07793000d7c6 records amount_owed 3.00, amount_paid 0.00, source engine.finishTournament, settled_at null. '
    'The spin drew 3.00 from the reserve (spin_reserve_ledger jackpot_draw, and spin_bonus_pools.balance agrees with that ledger to the cent, so the reserve really was debited) but the escrow shows reserve_in 0.00 and closed at zero twelve seconds after the obligation was created. '
    'pokerdale has no chip_ledger prize leg and no prize credit in wallet_transactions for this tournament, while the same account was paid promptly for three other spins in the same hour. '
    'The other ten open fn_spin_unpaid_check incidents owe nothing: nine were CANCELLED and returned their entire draw to the reserve (514.00 of surplus_return), and one (ChipQueen, 30.00) was paid an hour after its alert and the incident simply never re-read itself.';
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  /* ── THIS IS NOT A MINT, IT IS THE SECOND HALF OF A TRANSFER ─────────────
     The reserve was debited 3.00 at 02:52:04 and spin_bonus_pools.balance
     agrees with spin_reserve_ledger to the cent, so those chips genuinely
     left the reserve. The escrow's own row records reserve_in = 0.00: the
     matching credit was never written, and the escrow then closed at zero
     while an unsettled obligation stood against it.

     So the chips are in flight, not missing, and paying the winner completes
     a transfer the platform already funded. Conservation is restored by this
     migration, not disturbed by it: reserve down 3.00 (already recorded),
     player up 3.00 (recorded here). Funding this from the club treasury
     instead would charge Midway Union twice for one prize. */

  SELECT round(COALESCE(reserve_in, 0), 2) INTO v_reserve_in
    FROM public.tournament_escrow
   WHERE tournament_id = '781cc0ee-6a1d-4e31-acaf-4e737661bba1';
  IF v_reserve_in IS DISTINCT FROM 0.00 THEN
    RAISE EXCEPTION
      'escrow reserve_in is %, not the 0.00 measured on 2026-09-08. The draw may since have been credited; re-read before paying.', v_reserve_in;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_obligations
     WHERE id = 'd367f526-d950-4b4a-af4d-07793000d7c6'
       AND settled_at IS NULL
       AND round(amount_owed - COALESCE(amount_paid, 0), 2) = 3.00
  ) THEN
    RAISE EXCEPTION 'the obligation is no longer 3.00 and unsettled; nothing written';
  END IF;

  /* SUM EVERY MEMBERSHIP, DO NOT NAME ONE. A first draft of this migration
     watched club_members at Midway Union, where the spin was played, saw
     25000.00 before and 25000.00 after, and would have reported the payment
     as having moved nothing. The credit actually lands on the player's SHARK
     CLUB membership (13715.09 -> 13718.09): atomic_credit_wallet_and_log
     picks the membership itself, and the settle path does not set
     app.ledger_club_id. The player is made whole either way, so that routing
     question is recorded in the changelog rather than fixed here - but the
     assertion must watch every wallet the player holds, or it checks the
     wrong one and calls a real payment a failure. */
  SELECT COALESCE(sum(chip_balance), 0) INTO v_before FROM public.club_members
   WHERE user_id = 'c402b38e-7ba6-40bf-a2d3-d65376d28ccf';

  -- The draw's missing credit, recorded where it should have been.
  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id => '781cc0ee-6a1d-4e31-acaf-4e737661bba1'::uuid,
    p_what          => 'the jackpot draw that never reached the escrow',
    p_reserve_in    => 3.00);

  v_adj := public.fn_ca_adjustment_under_10_9(
    '781cc0ee-6a1d-4e31-acaf-4e737661bba1'::uuid,
    'c402b38e-7ba6-40bf-a2d3-d65376d28ccf'::uuid,
    3.00, v_reason,
    '20260908132643_the_spin_that_drew_a_prize_and_paid_nobody',
    'chip standard (Claude)');

  SELECT public.fn_settle_tournament_obligation(
    '781cc0ee-6a1d-4e31-acaf-4e737661bba1'::uuid, 'place', 1,
    'c402b38e-7ba6-40bf-a2d3-d65376d28ccf'::uuid, 3.00,
    'agent.settle_10_9',
    'Spin prize owed to the recorded winner; the draw left the reserve and never reached the escrow',
    v_adj) INTO v_settle;

  IF COALESCE((v_settle->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'settlement refused (%), nothing written', v_settle::text;
  END IF;

  SELECT COALESCE(sum(chip_balance), 0) INTO v_after FROM public.club_members
   WHERE user_id = 'c402b38e-7ba6-40bf-a2d3-d65376d28ccf';

  IF round(v_after - v_before, 2) IS DISTINCT FROM 3.00 THEN
    RAISE EXCEPTION
      'the winner''s wallets moved by %, not 3.00; nothing is committed', round(v_after - v_before, 2);
  END IF;

  RAISE NOTICE 'spin prize settled: pokerdale wallets % -> % (adjustment %)',
    v_before, v_after, v_adj;
END $mig$;
