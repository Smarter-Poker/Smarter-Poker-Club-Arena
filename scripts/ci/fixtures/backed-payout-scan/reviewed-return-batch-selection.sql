    WITH eligible AS MATERIALIZED (
      SELECT t.id, t.name, t.club_id, t.prize_pool, t.ended_at
      FROM public.tournaments t
      WHERE t.status = 'COMPLETED'
        AND NOT (COALESCE(t.variant, '') = 'satellite' OR UPPER(COALESCE(t.tournament_type, '')) = 'SATELLITE' OR t.satellite_target_id IS NOT NULL)
        AND COALESCE(t.variant, '') <> 'spin'
        AND t.ended_at > now() - make_interval(days => GREATEST(v_window_days, 1))
    ), wallet_receipts AS MATERIALIZED (
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
    ), seat_income AS MATERIALIZED (
      SELECT e.id, sum(sp.amount) AS amount
      FROM public.tournament_payouts sp
      JOIN eligible e ON sp.metadata->>'satellite_target_id' = e.id::text
      LEFT JOIN public.tournament_satellite_awards a
        ON a.tournament_id = sp.tournament_id AND a.place = sp.position
      LEFT JOIN public.tournament_tickets k ON k.id = a.ticket_id
      WHERE sp.source IN ('satellite_seat','satellite_ticket')
        AND COALESCE(a.delivery_kind, 'seat') IN ('seat','ticket')
        AND (k.id IS NULL OR k.status = 'redeemed')
      GROUP BY e.id
    ), seat_outgoing AS MATERIALIZED (
      SELECT e.id, sum(sp.amount) AS amount
      FROM public.tournament_payouts sp JOIN eligible e ON e.id = sp.tournament_id
      LEFT JOIN public.tournament_satellite_awards a
        ON a.tournament_id = sp.tournament_id AND a.place = sp.position
      LEFT JOIN public.tournament_tickets k ON k.id = a.ticket_id
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
          + COALESCE(b.amount, 0) + COALESCE(si.amount, 0) - COALESCE(so.amount, 0), 2) AS delta
      FROM eligible e
      LEFT JOIN wallet_totals w ON w.id = e.id
      LEFT JOIN rake_totals rr ON rr.id = e.id
      LEFT JOIN overlay_totals l ON l.id = e.id
      LEFT JOIN returned_overlays ro ON ro.id = e.id
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
