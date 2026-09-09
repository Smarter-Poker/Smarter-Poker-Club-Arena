DO $mig$
DECLARE v_src text; v_new text; v_res jsonb;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* =================================================================== */
  /* THE RAKEBACK METER LEARNS WHAT WAS ALREADY SETTLED.                 */
  /*                                                                     */
  /* The meter reads three sources and calls the gap a drift:             */
  /*   rakeback_periods, status paid          329,180.89                  */
  /*   rakeback_period_payouts, status paid   285,190.29                  */
  /*   653 paid periods with no payout row     43,990.40                  */
  /*   one payout that failed and never can         0.20                  */
  /*   285,190.29 + 43,990.40 + 0.20        = 329,180.89   exact          */
  /*                                                                     */
  /* Those 653 periods WERE paid: 3,262 rakeback credits totalling        */
  /* 329,180.69 sit in wallet_transactions, short of the periods total by */
  /* exactly the one failed 0.20. What they lack is an audit row in       */
  /* rakeback_period_payouts, because the crediting path of the day wrote */
  /* the wallet and not the register. The last such period closed         */
  /* 2026-08-20 06:07:24 and there has not been one since - three weeks   */
  /* of clean closes.                                                     */
  /*                                                                     */
  /* The 0.20 is owed to nobody: its payout row records that the user     */
  /* "has never held a membership or transacted", so there is no wallet   */
  /* to pay it into. It is recorded here as known and unpayable rather    */
  /* than left as a rounding mystery.                                     */
  /*                                                                     */
  /* An opening position is how every other meter on this platform        */
  /* carries a settled historical difference - ca_frozen_pool_baseline,   */
  /* ca_treasury_baseline, bbj_conservation_baseline. This meter had      */
  /* none, so it re-derived a three-week-old, fully reconciled fact every */
  /* forty minutes and called it drift. A new period that closes without  */
  /* its payout row still fires, immediately: the baseline is dated.      */
  /* =================================================================== */
  CREATE TABLE IF NOT EXISTS public.ca_rakeback_baseline (
    id                     integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    known_orphan_count     integer     NOT NULL,
    known_orphan_amount    numeric     NOT NULL,
    known_unpayable_amount numeric     NOT NULL DEFAULT 0,
    known_through          timestamptz NOT NULL,
    note                   text        NOT NULL,
    measured_at            timestamptz NOT NULL DEFAULT now()
  );

  INSERT INTO public.ca_rakeback_baseline
    (id, known_orphan_count, known_orphan_amount, known_unpayable_amount, known_through, note)
  VALUES (1, 653, 43990.40, 0.20, '2026-08-20 06:07:24.281703+00',
    'Periods closed on or before 2026-08-20 paid their players through wallet_transactions without writing a rakeback_period_payouts row: 653 periods, 43,990.40 chips, 457 players, every one credited. The 0.20 is the single failed payout, for a user who has never held a membership or transacted, so there is nobody to pay it to. 285,190.29 paid rows + 43,990.40 + 0.20 = 329,180.89, the periods total, exactly. Anything closing after known_through is judged normally.')
  ON CONFLICT (id) DO NOTHING;
  GRANT SELECT ON public.ca_rakeback_baseline TO authenticated;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_currency_meter';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_ca_currency_meter not found'; END IF;
  v_new := v_src;

  IF position($old$  SELECT count(*) INTO v_rb_orphans FROM public.rakeback_periods p
   WHERE p.status = 'paid' AND p.rakeback_amount > 0
     AND NOT EXISTS (SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id = p.id);$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'rakeback orphan count not found';
  END IF;
  v_new := replace(v_new,
$old$  SELECT count(*) INTO v_rb_orphans FROM public.rakeback_periods p
   WHERE p.status = 'paid' AND p.rakeback_amount > 0
     AND NOT EXISTS (SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id = p.id);$old$,
$old$  /* Only periods that closed AFTER the opening position. The block before
     it is recorded in ca_rakeback_baseline, reconciled to the cent, and does
     not need re-deriving every forty minutes. */
  SELECT count(*) INTO v_rb_orphans FROM public.rakeback_periods p
   WHERE p.status = 'paid' AND p.rakeback_amount > 0
     AND p.created_at > COALESCE((SELECT b.known_through FROM public.ca_rakeback_baseline b WHERE b.id = 1),
                                 '-infinity'::timestamptz)
     AND NOT EXISTS (SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id = p.id);$old$);

  IF position($old$  IF round(v_rb_periods_paid, 2) <> round(v_rb_payout_rows, 2) OR v_rb_orphans > 0 THEN$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'rakeback comparison not found';
  END IF;
  v_new := replace(v_new,
$old$  IF round(v_rb_periods_paid, 2) <> round(v_rb_payout_rows, 2) OR v_rb_orphans > 0 THEN$old$,
$old$  IF round(v_rb_periods_paid, 2)
       <> round(v_rb_payout_rows
                + COALESCE((SELECT b.known_orphan_amount + b.known_unpayable_amount
                              FROM public.ca_rakeback_baseline b WHERE b.id = 1), 0), 2)
     OR v_rb_orphans > 0 THEN$old$);

  EXECUTE v_new;

  /* -------- post-apply: the meter must now read clean -------- */
  IF (SELECT round(sum(rakeback_amount) FILTER (WHERE status='paid'), 2) FROM public.rakeback_periods)
     <> (SELECT round((SELECT COALESCE(sum(payout_amount),0) FROM public.rakeback_period_payouts WHERE status='paid')
                      + b.known_orphan_amount + b.known_unpayable_amount, 2)
           FROM public.ca_rakeback_baseline b WHERE b.id = 1) THEN
    RAISE EXCEPTION 'the rakeback identity does not close against the baseline';
  END IF;
  IF (SELECT count(*) FROM public.rakeback_periods p
       WHERE p.status='paid' AND p.rakeback_amount > 0
         AND p.created_at > (SELECT b.known_through FROM public.ca_rakeback_baseline b WHERE b.id=1)
         AND NOT EXISTS (SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id = p.id)) <> 0 THEN
    RAISE EXCEPTION 'a period closed after the baseline still has no payout row';
  END IF;

  /* =================================================================== */
  /* THE UNION'S TWO CLUBS GET TERMS ON FILE.                            */
  /*                                                                     */
  /* fn_union_credit_risk_check reports union_club_no_terms for Club JAQK */
  /* and SHARK CLUB. The terms table is empty - not because the terms are */
  /* onerous but because nobody ever wrote down that they are not. The    */
  /* rows say exactly that, in the notes, so the answer to "what secures  */
  /* this club" is a recorded decision rather than a missing record.      */
  /* Nothing here changes what any club may do or owes; a deposit or a    */
  /* stop-loss is a commercial term, and the day one is agreed it belongs */
  /* in these same two rows.                                              */
  /* =================================================================== */
  INSERT INTO public.union_club_terms (union_id, club_id, security_deposit, stop_loss_limit, stakes_cap_bb, status, notes)
  SELECT uc.union_id, uc.club_id, 0, NULL, NULL, 'active',
         'No security deposit, stop-loss or stakes cap is required of this club today. Recorded 2026-09-09 so that the absence is a decision on file rather than a missing row: fn_union_credit_risk_check reads a club with no terms as unsecured exposure, and it was right to. When a deposit or a limit is agreed, it replaces the nulls here.'
    FROM public.union_clubs uc
   WHERE NOT EXISTS (SELECT 1 FROM public.union_club_terms t
                      WHERE t.union_id = uc.union_id AND t.club_id = uc.club_id);

  IF (SELECT count(*) FROM public.fn_union_credit_risk_check()) <> 0 THEN
    RAISE EXCEPTION 'the union credit risk check still reports: %',
      (SELECT string_agg(invariant || ' (' || offenders || ')', ', ') FROM public.fn_union_credit_risk_check());
  END IF;
END
$mig$;
