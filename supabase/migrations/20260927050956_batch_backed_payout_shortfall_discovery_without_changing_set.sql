-- The existing no-argument cron spends its 120-second deadline repeating the
-- same conservation queries for every eligible completed event. Aggregate the
-- same receipts by event once. Preserve the full 30-day candidate set, delta
-- rounding, oldest-first limit, wallet double-pay refusal, alert deduplication,
-- and every byte of the loop including the existing explicit p_apply branch.
-- This installs no scheduler and executes no payer or financial-data write.
-- The separate scalar conservation function remains byte-identical; its exact
-- definition is guarded because the set query must retain all its terms.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure)) = 'f4365f6a123257d70d68a525eed9f7b0')
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '8s';
DO $patch$
DECLARE
  v_target regprocedure := 'public.fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure;
  v_old text := pg_get_functiondef(v_target);
  v_new text;
  v_catalog record;
  v_start integer;
  v_end integer;
  v_scan text := $scan$    WITH eligible AS MATERIALIZED (
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
          + GREATEST(COALESCE(l.overlay, 0), COALESCE(o.amount, 0))
          + COALESCE(b.amount, 0) + COALESCE(si.amount, 0) - COALESCE(so.amount, 0), 2) AS delta
      FROM eligible e
      LEFT JOIN wallet_totals w ON w.id = e.id
      LEFT JOIN rake_totals rr ON rr.id = e.id
      LEFT JOIN overlay_totals l ON l.id = e.id
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
    LIMIT GREATEST(p_limit, 1)$scan$;
BEGIN
  IF md5(v_old) IS DISTINCT FROM '9bf0cce25df7f2c4dcae32f2c42d2cd3'
     OR md5(pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure))
        IS DISTINCT FROM '0d3b61282e592f3f938e77dcb1bf4a98' THEN
    RAISE EXCEPTION 'BACKED_PAYOUT_SCAN_PREIMAGE_CHANGED' USING ERRCODE = '55000';
  END IF;
  SELECT oid, proowner, proacl, proconfig INTO STRICT v_catalog FROM pg_proc WHERE oid=v_target;
  IF v_catalog.proowner <> 'postgres'::regrole
     OR has_function_privilege('anon',v_target,'EXECUTE')
     OR has_function_privilege('authenticated',v_target,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_target,'EXECUTE') THEN
    RAISE EXCEPTION 'BACKED_PAYOUT_SCAN_AUTHORITY_CHANGED' USING ERRCODE = '55000';
  END IF;
  -- Scalar singleton lookups error on duplicate side-table rows. The batch
  -- joins preserve that contract only while the exact unique keys still hold.
  IF EXISTS (
    SELECT FROM (VALUES ('public.tournament_guarantee_overlays'::regclass),
                        ('public.tournament_conservation_baseline'::regclass)) singleton(rel)
    WHERE NOT EXISTS (
      SELECT FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid
        AND a.attname='tournament_id' AND a.attnum=i.indkey[0]
      WHERE i.indrelid=singleton.rel AND i.indisunique AND i.indisvalid
        AND i.indisready AND i.indislive AND i.indimmediate
        AND i.indnkeyatts=1 AND i.indpred IS NULL AND i.indexprs IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'BACKED_PAYOUT_SCAN_SINGLETON_KEYS_CHANGED' USING ERRCODE = '55000';
  END IF;
  -- The measured read uses this existing covering index. Refuse schema drift
  -- rather than installing a query qualified against a missing/different path.
  IF NOT EXISTS (
    SELECT FROM pg_index i
    WHERE i.indexrelid=to_regclass('public.idx_rake_records_club_data_tournament_window')
      AND i.indrelid='public.rake_records'::regclass
      AND i.indisvalid AND i.indisready AND i.indislive
      AND md5(pg_get_indexdef(i.indexrelid))='6d9d8de5ba1748d29a87d3ddade323d3'
  ) THEN
    RAISE EXCEPTION 'BACKED_PAYOUT_SCAN_COVER_CHANGED' USING ERRCODE = '55000';
  END IF;
  v_start := strpos(v_old,'    SELECT t.id, t.name, t.club_id, t.prize_pool,');
  v_end := strpos(v_old,E'\n  LOOP');
  IF md5(substring(v_old FROM v_start FOR v_end-v_start)) <> '561e1d9c724ef909b3d94cbfc1975baa' THEN
    RAISE EXCEPTION 'BACKED_PAYOUT_SCAN_SELECTION_CHANGED' USING ERRCODE = '55000';
  END IF;
  v_new := substring(v_old FROM 1 FOR v_start-1) || v_scan || substring(v_old FROM v_end);
  IF md5(v_new) <> 'f4365f6a123257d70d68a525eed9f7b0' THEN
    RAISE EXCEPTION 'BACKED_PAYOUT_SCAN_RESULT_CHANGED' USING ERRCODE = '55000';
  END IF;
  EXECUTE v_new;
  IF NOT EXISTS (SELECT FROM pg_proc WHERE oid=v_catalog.oid
                AND proowner=v_catalog.proowner AND proacl IS NOT DISTINCT FROM v_catalog.proacl
                AND proconfig IS NOT DISTINCT FROM v_catalog.proconfig)
     OR md5(pg_get_functiondef(v_target)) <> 'f4365f6a123257d70d68a525eed9f7b0' THEN
    RAISE EXCEPTION 'BACKED_PAYOUT_SCAN_READBACK_CHANGED' USING ERRCODE = '55000';
  END IF;
END
$patch$;
COMMIT;
