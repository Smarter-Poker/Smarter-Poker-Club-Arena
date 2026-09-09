DO $mig$
DECLARE
  c_tid constant uuid := 'a2e30c1f-6d9f-4e5a-81ba-9639a8298d1a';
  v_club uuid; v_pool_before numeric; v_pool_after numeric;
  v_escrow_before numeric; v_escrow_after numeric; v_closed timestamptz;
  v_returns_before int; v_returns_after int; v_res jsonb;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* =================================================================== */
  /* 262.00 CHIPS GO BACK TO THE RESERVE THAT LENT THEM.                 */
  /*                                                                     */
  /* "50 Chip Spin PLO4" (a2e30c1f, 2026-09-08) drew 500.00 from the      */
  /* club's spin reserve, paid 100.00 to second place, was cancelled, and */
  /* refunded all three entrants their 50.00 stakes out of the same       */
  /* escrow. 262.00 of the draw was never spent by anybody and has sat in */
  /* that event's escrow since 15:07 on 2026-09-08.                       */
  /*                                                                     */
  /* NOBODY IS OWED A CHIP. The three entrants have their buy-ins back;   */
  /* second place keeps the 100.00 they won before the cancellation. This */
  /* is the house's own money in the wrong pocket, and it comes home.     */
  /*                                                                     */
  /* Nothing is hand-written here: fn_ca_return_unawarded_spin_draws does */
  /* it, so the pool balance, the reserve ledger, the chip journal and    */
  /* the escrow all move together on the paths that already exist. The    */
  /* return is a spin_entry leg, which is what fn_ca_escrow_on_reserve_leg*/
  /* listens for, so the escrow closes itself rather than being edited.   */
  /* =================================================================== */

  SELECT t.club_id INTO v_club FROM public.tournaments t WHERE t.id = c_tid;
  IF v_club IS NULL THEN RAISE EXCEPTION 'tournament % not found', c_tid; END IF;

  SELECT COALESCE(sum(balance), 0) INTO v_pool_before FROM public.spin_bonus_pools WHERE club_id = v_club;
  SELECT prize_balance, closed_at INTO v_escrow_before, v_closed FROM public.tournament_escrow WHERE tournament_id = c_tid;
  SELECT count(*) INTO v_returns_before FROM public.spin_reserve_ledger
   WHERE tournament_id = c_tid AND kind = 'surplus_return';

  IF v_escrow_before IS DISTINCT FROM 262.00 THEN
    RAISE EXCEPTION 'expected 262.00 unspent in the escrow, found %', v_escrow_before;
  END IF;
  IF v_closed IS NOT NULL THEN RAISE EXCEPTION 'the escrow is already closed'; END IF;
  IF v_returns_before <> 0 THEN RAISE EXCEPTION 'a surplus_return already exists for this spin'; END IF;

  v_res := public.fn_ca_return_unawarded_spin_draws(true, 200);

  SELECT COALESCE(sum(balance), 0) INTO v_pool_after FROM public.spin_bonus_pools WHERE club_id = v_club;
  SELECT prize_balance, closed_at INTO v_escrow_after, v_closed FROM public.tournament_escrow WHERE tournament_id = c_tid;
  SELECT count(*) INTO v_returns_after FROM public.spin_reserve_ledger
   WHERE tournament_id = c_tid AND kind = 'surplus_return';

  IF round(v_pool_after - v_pool_before, 2) <> 262.00 THEN
    RAISE EXCEPTION 'the reserve moved by % , expected 262.00', round(v_pool_after - v_pool_before, 2);
  END IF;
  IF round(COALESCE(v_escrow_after, 0), 2) <> 0.00 THEN
    RAISE EXCEPTION 'the escrow still holds % after the return', v_escrow_after;
  END IF;
  IF v_closed IS NULL THEN RAISE EXCEPTION 'the escrow did not close behind the return'; END IF;
  IF v_returns_after <> 1 THEN RAISE EXCEPTION 'expected exactly one surplus_return row, found %', v_returns_after; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chip_ledger
                  WHERE from_entity_id = c_tid AND category = 'spin_entry'
                    AND amount = 262.00 AND created_at > now() - interval '2 minutes') THEN
    RAISE EXCEPTION 'no journal leg was written for the return';
  END IF;
  IF (SELECT count(*) FROM public.v_spin_unpaid_settlements WHERE tournament_id = c_tid) <> 0 THEN
    RAISE EXCEPTION 'the spin still reads as unpaid after the return';
  END IF;

  RAISE NOTICE 'spin reserve return: %', v_res;
END
$mig$;
