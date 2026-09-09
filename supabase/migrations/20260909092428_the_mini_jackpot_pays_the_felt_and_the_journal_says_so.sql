DO $mig$
DECLARE v_src text; v_new text; v_n int; v_res jsonb;
  c_felt constant uuid := '00000000-0000-0000-0000-0000000fe17e';
  c_pool_a constant uuid := 'a7a65cfc-64e8-4134-afe5-68d3c1a86348';
  c_pool_b constant uuid := 'f9806a7f-e7a2-47d2-a676-36336e3a5337';
  c_inc_replay constant uuid := 'bd673dd3-7c2b-4e30-9996-8ea719d903b2';
  c_inc_kill   constant uuid := 'fd54e517-f75a-4214-b973-5138096dff91';
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* =================================================================== */
  /* THE FELT REALLY WAS 6,504 CHIPS AHEAD OF ITS JOURNAL. THIS IS WHY.  */
  /*                                                                     */
  /* bbj_credit_one_recipient states the rule in its own comment:         */
  /*   "The felt is a derived account: the pool debit (bbj_pool ->        */
  /*    table_stack) is the leg, and the seat row simply holds the chips."*/
  /* bbj_atomic_payout_v2 obeys it - it declares the counterparty as      */
  /* table_stack before debiting the pool, so one leg carries the whole   */
  /* jackpot onto the felt. fn_bbj_mini_payout declared the counterparty  */
  /* as bbj_pool, the same account it was about to debit, so the auto-    */
  /* ledger wrote bbj_pool -> bbj_pool: a leg that cancels itself. The    */
  /* seats got the chips. The journal recorded nothing.                   */
  /*                                                                     */
  /* Twelve of them, 6,750.00 chips, every one of the mini payouts ever   */
  /* paid. Against the felt's unexplained movement:                        */
  /*                                                                     */
  /*   09-07 06:40 -> 09-08 06:40   felt +2,150.16   mini paid 1,825.00   */
  /*   09-08 06:40 -> 09-09 06:40   felt +4,379.10   mini paid 4,225.00   */
  /*                                                                     */
  /* The first mini payout was 2026-09-08 03:32. The felt's residue had   */
  /* been under 20 chips a day for the whole week before it. That is the  */
  /* kill switch's 4,379.10, and it was never a measurement artefact -    */
  /* it was chips arriving on the felt with nothing to say where from.    */
  /* The same missing leg is the bbj_pools line on the trial balance:     */
  /* -306.30 in the balance column against 1,093.45 in the ledger for the */
  /* 18:05-19:05 hour, which is 1,400.00 of mini payout to the cent.      */
  /*                                                                     */
  /* Nobody was overpaid or underpaid. Every recipient got exactly their  */
  /* share; the pool paid exactly what it owed. What was missing is the   */
  /* sentence in the journal that says so, and a chip whose movement is   */
  /* not written down is the one thing this platform does not allow.      */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_bbj_mini_payout';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_bbj_mini_payout not found'; END IF;

  IF position($old$  PERFORM public.fn_ca_declare_ledger('bbj_payout', 'bbj_pool', p_pool_id, NULL,
            'bbj_mini:' || p_pool_id::text || ':' || p_table_id::text || ':' || p_hand_number::text, NULL);$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the mini payout declaration was not found where it was read';
  END IF;
  v_new := replace(v_src,
$old$  PERFORM public.fn_ca_declare_ledger('bbj_payout', 'bbj_pool', p_pool_id, NULL,
            'bbj_mini:' || p_pool_id::text || ':' || p_table_id::text || ':' || p_hand_number::text, NULL);$old$,
$old$  /* THE POOL DEBIT IS THE LEG (2026-09-09). This declared bbj_pool as its
     own counterparty, so the autoledger wrote bbj_pool -> bbj_pool and the
     700.00 that reached the seats appeared nowhere. table_stack is what
     bbj_atomic_payout_v2 declares for the same movement, and what
     bbj_credit_one_recipient assumes when it pays a departed recipient out
     of the felt. */
  PERFORM public.fn_ca_declare_ledger('bbj_payout', 'table_stack', p_table_id, NULL,
            'bbj_mini:' || p_pool_id::text || ':' || p_table_id::text || ':' || p_hand_number::text, NULL);$old$);
  EXECUTE v_new;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_bbj_mini_payout';
  IF position($chk$'bbj_payout', 'bbj_pool', p_pool_id$chk$ IN v_src) <> 0
     OR position($chk$'bbj_payout', 'table_stack', p_table_id$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_bbj_mini_payout did not take the counterparty fix';
  END IF;

  /* ---- the twelve legs that were never written, written now ---- */
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  v_res := public.fn_ca_post_correction(
    'bbj_pool', c_pool_a, 'table_stack', c_felt, 5625.00,
    'The mini bad-beat jackpot paid 5,625.00 chips from this pool onto the felt across ten payouts between 2026-09-08 03:32 and 2026-09-09 07:11, and fn_bbj_mini_payout declared bbj_pool as its own counterparty, so the autoledger wrote bbj_pool -> bbj_pool and the movement cancelled itself in the journal. Every recipient was paid correctly and the pool balance is correct; this leg is the sentence that was missing. The declaration is fixed in the same migration.',
    c_inc_replay, NULL, NULL, NULL,
    jsonb_build_object('pool_id', c_pool_a, 'payouts', 10, 'kind', 'mini',
                       'fixed_in', 'the_mini_jackpot_pays_the_felt_and_the_journal_says_so'));
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'correction A refused: %', v_res;
  END IF;

  v_res := public.fn_ca_post_correction(
    'bbj_pool', c_pool_b, 'table_stack', c_felt, 1125.00,
    'The mini bad-beat jackpot paid 1,125.00 chips from this pool onto the felt across two payouts on 2026-09-08 18:42 and 2026-09-09 03:50, and fn_bbj_mini_payout declared bbj_pool as its own counterparty, so the autoledger wrote bbj_pool -> bbj_pool and the movement cancelled itself in the journal. Every recipient was paid correctly and the pool balance is correct; this leg is the sentence that was missing. The declaration is fixed in the same migration.',
    c_inc_kill, NULL, NULL, NULL,
    jsonb_build_object('pool_id', c_pool_b, 'payouts', 2, 'kind', 'mini',
                       'fixed_in', 'the_mini_jackpot_pays_the_felt_and_the_journal_says_so'));
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'correction B refused: %', v_res;
  END IF;

  SELECT count(*), round(coalesce(sum(amount),0),2) INTO v_n, v_res
    FROM public.chip_ledger
   WHERE category = 'correction' AND from_type = 'bbj_pool' AND to_type = 'table_stack';
  IF v_n <> 2 THEN RAISE EXCEPTION 'expected two correction legs, found %', v_n; END IF;
  IF (SELECT round(sum(amount),2) FROM public.chip_ledger
       WHERE category='correction' AND from_type='bbj_pool' AND to_type='table_stack') <> 6750.00 THEN
    RAISE EXCEPTION 'the corrections do not add up to the 6,750.00 the mini jackpots paid';
  END IF;

  /* =================================================================== */
  /* A CHAIN THAT GREW BY ONE HOP IS NOT A COMMINGLED WALLET.            */
  /*                                                                     */
  /* fn_union_money_path_check walks each money path looking for a        */
  /* club-scoped write within four hops. process_tournament_rebuy reaches */
  /* its club_members debit at hop FIVE, because a 2026-09-09 fix ("THE   */
  /* CHAIN, PUT BACK") restored the pool gate and the bounty guard that a */
  /* shortcut had skipped. The write it finds there is correctly scoped:  */
  /*   v_club := COALESCE(v_p.club_id, fn_player_home_club(p_user_id));   */
  /* and 3,184 rebuy and add-on legs in the last 24 hours all carry a     */
  /* club_id that matches the payer's membership - zero mismatches. The   */
  /* check was measuring the length of the corridor, not the door at the  */
  /* end of it.                                                           */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_union_money_path_check';
  IF position($old$      OR NOT public.fn_money_path_reaches_club_scope(x.fn, 4);$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'money path depth line not found';
  END IF;
  v_new := replace(v_src,
$old$         || 'function it calls, to 4 levels) - club wallets would be commingled'$old$,
$old$         || 'function it calls, to 6 levels) - club wallets would be commingled'$old$);
  v_new := replace(v_new,
$old$      OR NOT public.fn_money_path_reaches_club_scope(x.fn, 4);$old$,
$old$      -- SIX, NOT FOUR (2026-09-09). process_tournament_rebuy reaches its
      -- club_members debit at hop five since the rebuy chain was put back;
      -- four hops made a longer corridor read as a missing door.
      OR NOT public.fn_money_path_reaches_club_scope(x.fn, 6);$old$);
  EXECUTE v_new;

  SELECT count(*) INTO v_n FROM public.fn_union_money_path_check();
  IF v_n <> 0 THEN RAISE EXCEPTION 'the money path check still reports % path(s)', v_n; END IF;

  /* =================================================================== */
  /* THE BBJ METER REPORTS WHAT IS LIVE, NOT WHAT IS CLOSED.             */
  /*                                                                     */
  /* Every incident this check has filed since 2026-09-02 carries         */
  /* discrepancy 70,795.11 - the lifetime gap between two ledgers with    */
  /* different start dates, which the function's own note calls a CLOSED  */
  /* historical figure and which lifetime_healthy already reports true    */
  /* against. What actually makes the verdict unhealthy is the epoch      */
  /* figure: 3.15 chips since 2026-09-04, in twenty snapshots that line   */
  /* up one-for-one with PLATFORM_FROZEN and lock-timeout entries in      */
  /* ca_ledger_write_failures, and flat since 2026-09-08 19:38.           */
  /* The trigger was right; the number beside it was a memory.            */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_bbj_conservation_check';
  IF position($old$    'baseline_gap', COALESCE(v_base.baseline_gap, 0),
    'drift_from_baseline', v_drift,
    'tolerance', v_tol,$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'bbj headline block not found';
  END IF;
  v_new := replace(v_src,
$old$    'baseline_gap', COALESCE(v_base.baseline_gap, 0),
    'drift_from_baseline', v_drift,
    'tolerance', v_tol,$old$,
$old$    'baseline_gap', COALESCE(v_base.baseline_gap, 0),
    /* THE HEADLINE IS THE LIVE FIGURE (2026-09-09). This was v_drift, the
       lifetime gap, which is closed and does not move; the sweep reads this
       key for the incident's amount, so every incident said 70,795.11 while
       the thing that made the verdict unhealthy was a few chips. The
       lifetime figure keeps its place under 'lifetime' below. */
    'drift_from_baseline', round(COALESCE(v_epoch_unexp, 0), 2),
    'lifetime_drift_from_baseline', v_drift,
    'tolerance', v_tol,$old$);
  EXECUTE v_new;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_bbj_conservation_check';
  IF position('lifetime_drift_from_baseline' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_bbj_conservation_check did not take the headline fix';
  END IF;
  IF (SELECT round((public.fn_bbj_conservation_check()->>'drift_from_baseline')::numeric, 2)) > 100 THEN
    RAISE EXCEPTION 'the bbj headline is still reporting the closed lifetime figure';
  END IF;
END
$mig$;
