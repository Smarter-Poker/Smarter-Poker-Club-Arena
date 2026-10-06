CREATE OR REPLACE FUNCTION public.fn_tournament_conservation_deltas(p_since timestamp with time zone, p_until timestamp with time zone)
 RETURNS TABLE(id uuid, name text, variant text, ended_at timestamp with time zone, delta numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- THE CONSERVATION DELTA FOR A WHOLE WINDOW, IN ONE READ (2026-10-03).
  -- Exactly fn_tournament_conservation_delta's arithmetic, term for term, for
  -- every event the money-conservation scan covers: COMPLETED or CANCELLED,
  -- ended inside (p_since, p_until), not 'spin', and with a buy-in. Each term
  -- is summed once per table instead of once per event. A change to the
  -- scalar is a change to this function too: the native qualification and
  -- tests/the-conservation-scan-reads-every-event-in-one-pass.law.test.ts
  -- compare the two over the whole fixture population.
  WITH eligible AS MATERIALIZED (
    SELECT t.id, t.name, t.variant, t.ended_at
    FROM public.tournaments t
    WHERE t.status IN ('COMPLETED','CANCELLED')
      AND t.ended_at > p_since
      AND t.ended_at < p_until
      AND COALESCE(t.variant, '') NOT IN ('spin')
      AND COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) > 0
  ), wallet_totals AS MATERIALIZED (
    SELECT w.related_entity_id AS id,
      sum(w.amount) FILTER (WHERE w.type = 'debit' AND w.category IN ('tournament_buyin','rebuy','addon')) AS money_in,
      sum(w.amount) FILTER (WHERE w.type = 'credit' AND w.category = 'refund') AS refunds,
      sum(w.amount) FILTER (WHERE w.type = 'credit' AND w.category = 'prize') AS prizes,
      sum(w.amount) FILTER (WHERE w.type = 'credit' AND w.category = 'bounty') AS bounties
    FROM public.wallet_transactions w JOIN eligible e ON e.id = w.related_entity_id
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
    LEFT JOIN public.tournament_tickets k ON k.id = COALESCE(a.ticket_id, CASE WHEN sp.metadata->>'ticket_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (sp.metadata->>'ticket_id')::uuid END)
    WHERE sp.source IN ('satellite_seat','satellite_ticket')
      AND COALESCE(a.delivery_kind, 'seat') IN ('seat','ticket')
      AND (k.id IS NULL OR k.status = 'redeemed')
    GROUP BY e.id
  ), seat_outgoing AS MATERIALIZED (
    SELECT e.id, sum(sp.amount) AS amount
    FROM public.tournament_payouts sp JOIN eligible e ON e.id = sp.tournament_id
    LEFT JOIN public.tournament_satellite_awards a
      ON a.tournament_id = sp.tournament_id AND a.place = sp.position
    LEFT JOIN public.tournament_tickets k ON k.id = COALESCE(a.ticket_id, CASE WHEN sp.metadata->>'ticket_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (sp.metadata->>'ticket_id')::uuid END)
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
  )
  SELECT e.id, e.name, e.variant, e.ended_at,
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
$function$
