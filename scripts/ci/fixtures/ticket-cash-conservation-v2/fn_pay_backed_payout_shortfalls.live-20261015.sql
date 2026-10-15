CREATE OR REPLACE FUNCTION public.fn_pay_backed_payout_shortfalls(p_apply boolean DEFAULT false, p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; v_res jsonb;
  v_paid numeric := 0; v_events integer := 0;
  v_withheld numeric := 0; v_withheld_events integer := 0;
  v_refused integer := 0; v_refused_chips numeric := 0;
  v_alerts integer := 0;
  v_delta_after numeric;
  /* HOW FAR BACK THIS QUESTION REACHES (2026-09-19).
     There was no bound here, so fn_tournament_conservation_delta ran per row
     over every COMPLETED tournament and the job was cancelled at 120s on 21 of
     its last 24 runs. A shortfall is created at settlement and is detectable
     within hours; 30 days is about a 100x margin on that. Measured: bounded
     21,817 ms against production, unbounded over 120,000 ms and cancelled.
     Widen it deliberately if a shortfall is ever found older than this. */
  v_window_days integer := 30;
BEGIN
  FOR r IN
    WITH eligible AS MATERIALIZED (
      SELECT t.id, t.name, t.club_id, t.prize_pool, t.ended_at
      FROM public.tournaments t
      WHERE t.status = 'COMPLETED'
        AND NOT (COALESCE(t.variant, '') = 'satellite' OR UPPER(COALESCE(t.tournament_type, '')) = 'SATELLITE' OR t.satellite_target_id IS NOT NULL)
        AND COALESCE(t.variant, '') <> 'spin'
        -- A Diamond event is paid from its own diamond escrow, never by this
        -- chip sweep (2026-10-09). Its chip-side delta is meaningless.
        AND NOT EXISTS (SELECT 1 FROM public.clubs c
                         WHERE c.id = t.club_id AND c.asset = 'diamonds'
                           AND c.is_platform IS TRUE AND c.union_id IS NULL
                           AND t.union_id IS NULL)
        AND t.ended_at > now() - make_interval(days => GREATEST(v_window_days, 1))
    ), wallet_receipts AS NOT MATERIALIZED (
      SELECT related_entity_id, type, category, amount
      FROM public.wallet_transactions
      WHERE related_entity_id IS NOT NULL
        AND ((type = 'debit' AND category IN ('tournament_buyin','rebuy','addon'))
          OR (type = 'credit' AND category IN ('refund','prize','bounty')))
    ), wallet_totals AS MATERIALIZED (
      SELECT w.related_entity_id AS id,
        sum(w.amount) FILTER (WHERE w.type = 'debit' AND w.category IN ('tournament_buyin','rebuy','addon')) AS money_in,
        sum(w.amount) FILTER (WHERE w.type = 'credit' AND w.category = 'refund') AS refunds,
        sum(w.amount) FILTER (WHERE w.type = 'credit' AND w.category = 'prize') AS prizes,
        sum(w.amount) FILTER (WHERE w.type = 'credit' AND w.category = 'bounty') AS bounties
      FROM wallet_receipts w JOIN eligible e ON e.id = w.related_entity_id
      WHERE (w.type = 'debit' AND w.category IN ('tournament_buyin','rebuy','addon'))
         OR (w.type = 'credit' AND w.category IN ('refund','prize','bounty'))
      GROUP BY w.related_entity_id
    ), rake_totals AS MATERIALIZED (
      SELECT rr.tournament_id AS id, sum(rr.rake_amount) AS rake
      FROM public.rake_records rr JOIN eligible e ON e.id = rr.tournament_id
      WHERE rr.is_tournament AND rr.rake_amount <> 0 AND rr.tournament_id IS NOT NULL
      GROUP BY rr.tournament_id
    ), overlay_totals AS MATERIALIZED (
      SELECT l.tournament_id AS id, sum(l.amount) AS overlay
      FROM public.chip_ledger l JOIN eligible e ON e.id = l.tournament_id
      WHERE l.category = 'overlay' AND l.to_type = 'prize_liability'
      GROUP BY l.tournament_id
    ), returned_overlays AS MATERIALIZED (
      SELECT l.tournament_id AS id, sum(l.amount) AS returned
      FROM public.chip_ledger l JOIN eligible e ON e.id = l.tournament_id
      WHERE l.category = 'reversal' AND l.from_type = 'prize_liability'
        AND l.from_entity_id = l.tournament_id
        AND l.metadata->>'kind' = 'reviewed_void_overlay_return'
      GROUP BY l.tournament_id
    ), house_corrections AS MATERIALIZED (
      SELECT l.tournament_id AS id, sum(l.amount) AS amount
      FROM public.chip_ledger l JOIN eligible e ON e.id = l.tournament_id
      WHERE l.category = 'correction' AND l.to_type = 'prize_liability'
        AND l.from_type IN ('union_bank','club_treasury')
      GROUP BY l.tournament_id
    ), seat_income AS MATERIALIZED (
      SELECT e.id, sum(sp.amount) AS amount
      FROM public.tournament_payouts sp
      JOIN eligible e ON sp.metadata->>'satellite_target_id' = e.id::text
      LEFT JOIN public.tournament_satellite_awards a
        ON a.tournament_id = sp.tournament_id AND a.place = sp.position
      LEFT JOIN public.tournament_tickets k ON k.id = COALESCE(a.ticket_id, CASE WHEN sp.metadata->>'ticket_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (sp.metadata->>'ticket_id')::uuid END) -- no award row: the payout carries its ticket (2026-10-03)
      WHERE sp.source IN ('satellite_seat','satellite_ticket')
        AND sp.metadata->>'satellite_target_id' IS NOT NULL
        AND COALESCE(a.delivery_kind, 'seat') IN ('seat','ticket')
        AND (k.id IS NULL OR k.status = 'redeemed')
      GROUP BY e.id
    ), seat_outgoing AS MATERIALIZED (
      SELECT e.id, sum(sp.amount) AS amount
      FROM public.tournament_payouts sp JOIN eligible e ON e.id = sp.tournament_id
      LEFT JOIN public.tournament_satellite_awards a
        ON a.tournament_id = sp.tournament_id AND a.place = sp.position
      LEFT JOIN public.tournament_tickets k ON k.id = COALESCE(a.ticket_id, CASE WHEN sp.metadata->>'ticket_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (sp.metadata->>'ticket_id')::uuid END) -- no award row: the payout carries its ticket (2026-10-03)
      WHERE sp.source IN ('satellite_seat','satellite_ticket')
        AND COALESCE(a.delivery_kind, 'seat') IN ('seat','ticket')
        AND COALESCE(k.status, 'issued') IN ('issued','redeemed')
        AND NOT (
          k.id IS NULL
          AND EXISTS (SELECT 1 FROM public.wallet_transactions w
                      WHERE w.related_entity_id = e.id
                        AND w.type = 'credit' AND w.category = 'prize'
                        AND w.user_id = sp.user_id AND w.amount = sp.amount)
        )
      GROUP BY e.id
    ), deltas AS MATERIALIZED (
      SELECT e.*, COALESCE(w.prizes, 0) AS wallet_prizes,
        round(COALESCE(w.money_in, 0) - COALESCE(w.refunds, 0)
          - COALESCE(rr.rake, 0) - COALESCE(w.prizes, 0) - COALESCE(w.bounties, 0)
          + GREATEST(COALESCE(l.overlay, 0), COALESCE(o.amount, 0)) - COALESCE(ro.returned, 0)
          + COALESCE(hc.amount, 0)
          + COALESCE(b.amount, 0) + COALESCE(si.amount, 0) - COALESCE(so.amount, 0), 2) AS delta
      FROM eligible e
      LEFT JOIN wallet_totals w ON w.id = e.id
      LEFT JOIN rake_totals rr ON rr.id = e.id
      LEFT JOIN overlay_totals l ON l.id = e.id
      LEFT JOIN returned_overlays ro ON ro.id = e.id
      LEFT JOIN house_corrections hc ON hc.id = e.id
      LEFT JOIN public.tournament_guarantee_overlays o ON o.tournament_id = e.id
      LEFT JOIN public.tournament_conservation_baseline b ON b.tournament_id = e.id
      LEFT JOIN seat_income si ON si.id = e.id
      LEFT JOIN seat_outgoing so ON so.id = e.id
    )
    SELECT t.id, t.name, t.club_id, t.prize_pool,
      COALESCE((public.fn_tournament_payout_reconcile(t.id, false)->>'total_top_up')::numeric, 0) AS topup,
      t.delta, t.wallet_prizes
    FROM deltas t
    WHERE t.delta > 0.01
    ORDER BY t.ended_at ASC NULLS LAST
    LIMIT GREATEST(p_limit, 1)
  LOOP
    CONTINUE WHEN r.topup <= 0.005;

    /* CONSERVATION REFUSES BEFORE THE POOL DOES (2026-09-01).
       The reconciler computes "already paid" from tournament_payouts, on
       purpose - counting ledger rows instead caused two real double-pays. The
       cost of that choice is that an event whose record is incomplete reports
       a debt it does not have, and 61 events on this platform hold 5,515.91
       chips of prizes that reached wallets and were never recorded. If such a
       pool is ever funded, this sweep would pay them a second time.

       An event that has already disbursed its whole pool to wallets owes
       nobody, whatever the paperwork says. Refuse, and say so, so the record
       gets fixed rather than paid twice. */
    IF r.wallet_prizes + 0.01 >= COALESCE(r.prize_pool, 0) AND COALESCE(r.prize_pool, 0) > 0 THEN
      v_refused := v_refused + 1;
      v_refused_chips := v_refused_chips + r.topup;
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'warning', 'fn_pay_backed_payout_shortfalls',
             format('%s already paid %s of its %s pool to wallets, so the %s the reconciler reports as owed is a missing tournament_payouts record, not a debt. Paying nothing.',
                    COALESCE(r.name, r.id::text), round(r.wallet_prizes,2),
                    round(COALESCE(r.prize_pool,0),2), round(r.topup,2))
           , jsonb_build_object('kind','refused_already_disbursed','tournament_id',r.id,
               'club_id',r.club_id,'wallet_prizes',round(r.wallet_prizes,2),
               'prize_pool',round(COALESCE(r.prize_pool,0),2),'reported_top_up',round(r.topup,2))
       WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                          WHERE fa.source='fn_pay_backed_payout_shortfalls'
                            AND fa.resolved IS NOT TRUE
                            AND fa.context->>'kind'='refused_already_disbursed'
                            AND fa.context->>'tournament_id' = r.id::text);
      IF FOUND THEN v_alerts := v_alerts + 1; END IF;
      CONTINUE;
    END IF;

    -- The event must be holding at least what it is about to pay out. Not
    -- `delta >= 0` - that would let an event with 3 chips spare pay out 300.
    IF r.delta < r.topup THEN
      v_withheld := v_withheld + r.topup;
      v_withheld_events := v_withheld_events + 1;
      /* WITHHOLDING IS NEVER SILENT (2026-09-01).
         This branch used to increment a counter that reached a console line
         and nothing else. Money owed to a player and not paid produced no
         durable record anywhere, so nobody could find it later, and nobody
         did. It is a deduped alert now, per event, naming the gap. */
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'critical', 'fn_pay_backed_payout_shortfalls',
             format('%s owes players %s and its pool holds %s, so nothing was paid. The shortfall needs funding before anyone can be paid.',
                    COALESCE(r.name, r.id::text), round(r.topup,2), round(r.delta,2))
           , jsonb_build_object('kind','withheld_unfunded_pool','tournament_id',r.id,
               'club_id',r.club_id,'owed',round(r.topup,2),'pool_holds',round(r.delta,2),
               'funding_gap',round(r.topup - r.delta,2),
               'detail','no money was moved; funding an advertised guarantee is a human decision')
       WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                          WHERE fa.source='fn_pay_backed_payout_shortfalls'
                            AND fa.resolved IS NOT TRUE
                            AND fa.context->>'kind'='withheld_unfunded_pool'
                            AND fa.context->>'tournament_id' = r.id::text);
      IF FOUND THEN v_alerts := v_alerts + 1; END IF;
      CONTINUE;
    END IF;

    IF p_apply THEN
      /* ONE SETTLE PATH (Lane A3, 2026-09-02): the reconciler settles every
         place through fn_settle_tournament_obligation. `total_settled` is what
         that path actually paid; `total_top_up` is what was wanted. */
      v_res := public.fn_tournament_payout_reconcile(r.id, true);
      v_delta_after := public.fn_tournament_conservation_delta(r.id);

      IF v_delta_after < -0.01 THEN
        RAISE EXCEPTION 'paying % would leave conservation at %; refusing', r.id, v_delta_after;
      END IF;

      INSERT INTO public.tournament_payout_backfill_log
        (tournament_id, top_up, delta_before, delta_after)
      VALUES (r.id, COALESCE((v_res->>'total_settled')::numeric, (v_res->>'total_top_up')::numeric, r.topup), r.delta, v_delta_after)
      ON CONFLICT (tournament_id) DO UPDATE
        SET top_up = EXCLUDED.top_up,
            delta_before = EXCLUDED.delta_before,
            delta_after = EXCLUDED.delta_after;

      v_paid := v_paid + COALESCE((v_res->>'total_settled')::numeric, (v_res->>'total_top_up')::numeric, 0);
    ELSE
      v_paid := v_paid + r.topup;
    END IF;
    v_events := v_events + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'events_paid', v_events, 'chips_paid', round(v_paid, 2),
    'events_withheld_unfunded_pool', v_withheld_events,
    'chips_withheld_unfunded_pool', round(v_withheld, 2),
    'events_refused_already_disbursed', v_refused,
    'chips_refused_already_disbursed', round(v_refused_chips, 2),
    'alerts_raised', v_alerts,
    'window_days', v_window_days,
    'money_path', 'fn_settle_tournament_obligation');
END;
$function$
