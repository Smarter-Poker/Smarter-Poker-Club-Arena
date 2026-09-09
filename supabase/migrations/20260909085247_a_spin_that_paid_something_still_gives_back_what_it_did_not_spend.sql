DO $mig$
DECLARE v_src text; v_new text; v_before numeric; v_after numeric; v_pool_before numeric; v_pool_after numeric; v_res jsonb;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* =================================================================== */
  /* A SPIN THAT PAID SOMETHING STILL GIVES BACK WHAT IT DID NOT SPEND.  */
  /*                                                                     */
  /* "50 Chip Spin PLO4" (a2e30c1f) drew 500.00 from the shared spin      */
  /* reserve, paid 100.00 to second place, was then cancelled, and        */
  /* refunded 138.00 of buy-ins out of the same escrow. 262.00 of the     */
  /* draw was never spent and never went back. The reserve is still short */
  /* it today, and the event's escrow row is still open holding it.       */
  /*                                                                     */
  /*   reserve_in 500.00  -  prize_out 100.00  -  refunds 138.00          */
  /*                                          =  prize_balance 262.00     */
  /*                                                                     */
  /* Both return paths refused to look at it, for the same reason. The    */
  /* cancel trigger and the sweep each ask "has this spin paid ANY prize  */
  /* at all?" and give up entirely if it has:                             */
  /*   IF EXISTS (... category='prize') THEN RETURN NEW;                  */
  /*   AND NOT EXISTS (SELECT 1 FROM wallet_transactions ... 'prize')     */
  /* A spin that busts one player for 100 and is then cancelled falls     */
  /* through both forever. Of 899 cancelled spins in the last 14 days,    */
  /* 841 never drew at all and 57 returned their draw correctly; this is  */
  /* the one that paid first and was cancelled after.                     */
  /*                                                                     */
  /* The question was never "did anyone get paid". It is "is any of the   */
  /* draw still sitting here", and the escrow answers that exactly:       */
  /* prize_balance is what the event holds and has not spent. So the      */
  /* sweep returns THAT, capped by what was actually drawn, and closes    */
  /* the escrow behind it. Nobody is owed a chip either way - the three   */
  /* entrants got their stakes back and second place kept the 100.00 -    */
  /* this is house money finding its way home.                            */
  /*                                                                     */
  /* The return is written as a spin_entry leg, which is what             */
  /* fn_ca_escrow_on_reserve_leg already listens for, so the escrow       */
  /* follows the money instead of being edited beside it.                 */
  /* =================================================================== */
  CREATE OR REPLACE FUNCTION public.fn_ca_return_unawarded_spin_draws(p_apply boolean DEFAULT false, p_limit integer DEFAULT 200)
   RETURNS jsonb
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path TO 'public', 'pg_temp'
  AS $function$
  DECLARE
    r record; v_n int := 0; v_chips numeric := 0; v_bal numeric; v_amt numeric;
    v_ids uuid[] := '{}';
  BEGIN
    FOR r IN
      SELECT l.tournament_id, l.club_id,
             round(sum(CASE WHEN l.kind = 'jackpot_draw'   THEN -l.amount ELSE 0 END), 2) AS drawn,
             round(sum(CASE WHEN l.kind = 'surplus_return' THEN  l.amount ELSE 0 END), 2) AS returned,
             round(COALESCE(max(e.prize_balance), 0), 2) AS escrow_left
        FROM public.spin_reserve_ledger l
        JOIN public.tournaments t ON t.id = l.tournament_id
        LEFT JOIN public.tournament_escrow e ON e.tournament_id = l.tournament_id
       WHERE t.status IN ('CANCELLED', 'CANCELED', 'COMPLETED')
         AND COALESCE(t.ended_at, l.created_at) < now() - interval '10 minutes'
         AND l.tournament_id IS NOT NULL
       GROUP BY l.tournament_id, l.club_id
      HAVING round(COALESCE(max(e.prize_balance), 0), 2) > 0
         AND round(sum(CASE WHEN l.kind = 'jackpot_draw' THEN -l.amount ELSE 0 END), 2)
           > round(sum(CASE WHEN l.kind = 'surplus_return' THEN l.amount ELSE 0 END), 2)
       ORDER BY 5 DESC
       LIMIT GREATEST(p_limit, 1)
    LOOP
      /* The escrow says what is left; the reserve ledger says what can be
         owed back. Return the smaller of the two and nothing more. */
      v_amt := round(LEAST(r.escrow_left, r.drawn - r.returned), 2);
      IF v_amt <= 0 THEN CONTINUE; END IF;

      v_n := v_n + 1;
      v_chips := v_chips + v_amt;
      v_ids := v_ids || r.tournament_id;

      IF p_apply THEN
        /* spin_entry is the category fn_ca_escrow_on_reserve_leg reads, so
           the escrow moves with the chips rather than beside them. */
        PERFORM set_config('app.ledger_category', 'spin_entry', true);
        PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
        PERFORM set_config('app.ledger_counterparty_entity', r.tournament_id::text, true);

        UPDATE public.spin_bonus_pools
           SET balance = balance + v_amt
         WHERE club_id = r.club_id
        RETURNING balance INTO v_bal;

        PERFORM set_config('app.ledger_category', '', true);
        PERFORM set_config('app.ledger_counterparty', '', true);
        PERFORM set_config('app.ledger_counterparty_entity', '', true);

        IF FOUND THEN
          INSERT INTO public.spin_reserve_ledger
            (club_id, tournament_id, kind, amount, balance_after, note)
          VALUES (r.club_id, r.tournament_id, 'surplus_return', v_amt, v_bal,
                  'the part of the jackpot draw this spin never spent, returned to the reserve');

          UPDATE public.tournament_escrow
             SET closed_at = now(),
                 close_note = 'unspent spin draw returned to the reserve by fn_ca_return_unawarded_spin_draws'
           WHERE tournament_id = r.tournament_id
             AND closed_at IS NULL
             AND abs(COALESCE(prize_balance, 0)) < 0.005
             AND abs(COALESCE(bounty_balance, 0)) < 0.005
             AND abs(COALESCE(fee_balance, 0)) < 0.005;
        END IF;
      END IF;
    END LOOP;

    RETURN jsonb_build_object('ok', true, 'applied', p_apply,
                              'spins', v_n, 'chips_returned', round(v_chips, 2),
                              'tournament_ids', to_jsonb(v_ids));
  END;
  $function$;

  /* The cancel trigger's fast path stays - it is right for the ordinary case,
     a spin cancelled before anyone was paid - but it must not ABANDON the
     whole loop on the first club that has paid a prize. The sweep above is
     the authority for anything it skips. */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_spin_cancel_returns_draw';
  IF position($old$  IF EXISTS (SELECT 1 FROM public.wallet_transactions w
              WHERE w.related_entity_id = NEW.id
                AND w.type='credit' AND w.category='prize') THEN
    RETURN NEW;
  END IF;$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'spin cancel trigger prize guard not found';
  END IF;
  v_new := replace(v_src,
$old$  IF EXISTS (SELECT 1 FROM public.wallet_transactions w
              WHERE w.related_entity_id = NEW.id
                AND w.type='credit' AND w.category='prize') THEN
    RETURN NEW;
  END IF;$old$,
$old$  -- A spin that already paid a prize is not this trigger's to settle: the
  -- refunds have not been posted yet at this point in the cancel, so the
  -- escrow cannot say what is left. fn_ca_return_unawarded_spin_draws does
  -- it ten minutes later, when the escrow has stopped moving. CONTINUE, not
  -- RETURN: another club's funding on the same event still gets its draw back.
  IF EXISTS (SELECT 1 FROM public.wallet_transactions w
              WHERE w.related_entity_id = NEW.id
                AND w.type='credit' AND w.category='prize') THEN
    CONTINUE;
  END IF;$old$);
  EXECUTE v_new;

  /* =================================================================== */
  /* A REFUND IS A CHIP THAT REACHED A PLAYER.                           */
  /*                                                                     */
  /* v_spin_unpaid_settlements subtracted only wallet credits with        */
  /* category='prize' from the draw. The 138.00 that went back to the     */
  /* three entrants as category='refund' was invisible to it, so the      */
  /* alert read "400.00 short" where the true unspent figure was 262.00.  */
  /* 45 of the 164 alerts this check has ever raised were on CANCELLED    */
  /* spins where every entrant had already been refunded.                 */
  /*                                                                     */
  /* The escrow's prize_balance is the exact answer - what this event     */
  /* holds and has not spent - so where an escrow row exists it decides,  */
  /* and the old arithmetic remains the fallback for events without one.  */
  /* =================================================================== */
  CREATE OR REPLACE VIEW public.v_spin_unpaid_settlements AS
   WITH draw AS (
     SELECT l.tournament_id, sum(-l.amount) AS prize_drawn, max(l.created_at) AS drawn_at
       FROM spin_reserve_ledger l
      WHERE l.kind = 'jackpot_draw' AND l.tournament_id IS NOT NULL
      GROUP BY l.tournament_id
   ), returned AS (
     SELECT l.tournament_id, sum(l.amount) AS prize_returned
       FROM spin_reserve_ledger l
      WHERE l.kind = 'surplus_return' AND l.tournament_id IS NOT NULL
      GROUP BY l.tournament_id
   ), paid AS (
     SELECT w.related_entity_id AS tournament_id,
            sum(w.amount) FILTER (WHERE w.category = 'prize')  AS prize_credited,
            count(*)      FILTER (WHERE w.category = 'prize')  AS credit_rows,
            sum(w.amount) FILTER (WHERE w.category = 'refund') AS prize_refunded
       FROM wallet_transactions w
      WHERE w.type = 'credit' AND w.category IN ('prize','refund') AND w.related_entity_id IS NOT NULL
      GROUP BY w.related_entity_id
   ), seats AS (
     SELECT tp.tournament_id, count(*) AS seat_count,
            count(*) FILTER (WHERE tp."position" IS NULL) AS unranked_seats,
            count(*) FILTER (WHERE tp.status = 'playing') AS still_playing_seats,
            count(*) FILTER (WHERE tp."position" = 1) AS seats_at_first,
            COALESCE(sum(tp.prize), 0::numeric) AS sum_seat_prize
       FROM tournament_players tp
      GROUP BY tp.tournament_id
   )
   SELECT t.id AS tournament_id, t.club_id, t.name, t.status AS tournament_status,
          t.buy_in_amount, t.spin_multiplier, t.started_at, t.ended_at, d.drawn_at,
          d.prize_drawn,
          COALESCE(p.prize_credited, 0::numeric) AS prize_credited,
          COALESCE(p.credit_rows, 0::bigint) AS credit_rows,
          COALESCE(round(esc.prize_balance, 2),
                   round(d.prize_drawn - COALESCE(r.prize_returned, 0::numeric)
                                       - COALESCE(p.prize_credited, 0::numeric)
                                       - COALESCE(p.prize_refunded, 0::numeric), 2)) AS chips_short,
          COALESCE(s.seat_count, 0::bigint) AS seat_count,
          COALESCE(s.unranked_seats, 0::bigint) AS unranked_seats,
          COALESCE(s.still_playing_seats, 0::bigint) AS still_playing_seats,
          COALESCE(s.seats_at_first, 0::bigint) AS seats_at_first,
          COALESCE(s.sum_seat_prize, 0::numeric) AS sum_seat_prize,
          CASE
            WHEN COALESCE(r.prize_returned, 0::numeric) > 0::numeric THEN 'draw_returned'
            WHEN COALESCE(p.prize_credited, 0::numeric) = 0::numeric
                 AND COALESCE(p.prize_refunded, 0::numeric) = 0::numeric THEN 'nobody_paid'
            WHEN COALESCE(p.prize_credited, 0::numeric) < d.prize_drawn THEN 'under_paid'
            ELSE 'over_paid'
          END AS verdict,
          CASE
            WHEN COALESCE(s.unranked_seats, 0::bigint) > 0 THEN 'unranked_survivor'
            WHEN COALESCE(s.seats_at_first, 0::bigint) = 1 THEN 'ranked_but_unpaid'
            ELSE 'other'
          END AS seat_shape,
          COALESCE(r.prize_returned, 0::numeric) AS prize_returned,
          COALESCE(p.prize_refunded, 0::numeric) AS prize_refunded,
          esc.prize_balance AS escrow_prize_balance
     FROM draw d
     JOIN tournaments t ON t.id = d.tournament_id AND t.variant = 'spin'
     LEFT JOIN returned r ON r.tournament_id = d.tournament_id
     LEFT JOIN paid p ON p.tournament_id = d.tournament_id
     LEFT JOIN seats s ON s.tournament_id = d.tournament_id
     LEFT JOIN tournament_escrow esc ON esc.tournament_id = d.tournament_id
    WHERE COALESCE(round(esc.prize_balance, 2),
                   round(d.prize_drawn - COALESCE(r.prize_returned, 0::numeric)
                                       - COALESCE(p.prize_credited, 0::numeric)
                                       - COALESCE(p.prize_refunded, 0::numeric), 2)) <> 0::numeric
      AND ( (t.status = ANY (ARRAY['COMPLETED','CANCELLED','CANCELED'])
             AND COALESCE(t.ended_at, d.drawn_at) < now() - interval '10 minutes')
         OR (d.drawn_at < now() - interval '2 hours'
             AND t.status <> ALL (ARRAY['RUNNING','REGISTERING'])) )
      AND NOT (COALESCE(p.prize_credited, 0::numeric) > d.prize_drawn
               AND t.spin_multiplier IS NOT NULL
               AND COALESCE(p.prize_credited, 0::numeric) = round(t.buy_in_amount * t.spin_multiplier, 2));

  /* -------- post-apply assertions -------- */
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_return_unawarded_spin_draws'
         AND pg_get_functiondef(p.oid) LIKE '%escrow_left%') <> 1 THEN
    RAISE EXCEPTION 'the spin sweep did not take the escrow rewrite';
  END IF;
  IF position('CONTINUE;' IN (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_spin_cancel_returns_draw')) = 0 THEN
    RAISE EXCEPTION 'the spin cancel trigger did not take the CONTINUE fix';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='v_spin_unpaid_settlements'
         AND column_name IN ('prize_refunded','escrow_prize_balance')) <> 2 THEN
    RAISE EXCEPTION 'v_spin_unpaid_settlements did not take the refund columns';
  END IF;
END
$mig$;
