  -- The banks, cumulative journal and recent flow counters share one snapshot.
  -- Canonical incoming labels have bounded index values. The exceptional
  -- incoming branch and outgoing branch preserve arbitrary and NULL labels.
  WITH cumulative_legs AS (
    SELECT l.amount AS signed, l.to_label AS lbl
      FROM public.chip_ledger l
     WHERE l.to_entity_id = p_pool_id AND l.to_type = 'bbj_pool'
       AND l.created_at > v_base.taken_at
       AND (l.to_label IN ('bbj_pools.main_balance', 'bbj_pools.backup_balance', 'bbj_pools.promo_balance') AND octet_length(l.to_label) <= 64)
    UNION ALL
    SELECT CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.amount
                WHEN l.from_label LIKE 'bbj_pools.%' THEN -l.amount ELSE 0 END,
           CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.to_label
                WHEN l.from_label LIKE 'bbj_pools.%' THEN l.from_label END
      FROM public.chip_ledger l
     WHERE l.to_entity_id = p_pool_id AND l.to_type = 'bbj_pool'
       AND l.created_at > v_base.taken_at
       AND (l.to_label LIKE 'bbj_pools.%' OR l.from_label LIKE 'bbj_pools.%')
       AND (l.to_label IN ('bbj_pools.main_balance', 'bbj_pools.backup_balance', 'bbj_pools.promo_balance') AND octet_length(l.to_label) <= 64) IS NOT TRUE
    UNION ALL
    SELECT CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.amount
                WHEN l.from_label LIKE 'bbj_pools.%' THEN -l.amount ELSE 0 END,
           CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.to_label
                WHEN l.from_label LIKE 'bbj_pools.%' THEN l.from_label END
      FROM public.chip_ledger l
     WHERE l.from_entity_id = p_pool_id AND l.from_type = 'bbj_pool'
       AND (l.to_entity_id = p_pool_id AND l.to_type = 'bbj_pool') IS NOT TRUE
       AND l.created_at > v_base.taken_at
       AND (l.to_label LIKE 'bbj_pools.%' OR l.from_label LIKE 'bbj_pools.%')
  ), cumulative AS (
    SELECT COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.main_balance'), 0) AS m,
           COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.backup_balance'), 0) AS b,
           COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.promo_balance'), 0) AS p
      FROM cumulative_legs
  ), recent AS (
    SELECT COALESCE(sum(l.amount) FILTER (WHERE l.category = 'bbj_contribution' AND l.to_type = 'bbj_pool' AND l.from_type <> 'bbj_pool'), 0) AS drops,
           COALESCE(sum(l.amount) FILTER (WHERE l.category = 'bbj_payout' AND l.from_type = 'bbj_pool'), 0) AS payouts,
           COALESCE(sum(l.amount) FILTER (WHERE l.category = 'promo' AND l.from_type = 'bbj_pool'), 0) AS sweeps,
           COALESCE(sum(l.amount) FILTER (WHERE l.category = 'transfer' AND l.to_type = 'bbj_pool'), 0) AS funding,
           COALESCE(sum(l.amount) FILTER (WHERE l.from_type = 'bbj_pool' AND l.to_type = 'bbj_pool'), 0) / 2 AS moves
      FROM public.chip_ledger l
     WHERE ((l.to_entity_id = p_pool_id AND l.to_type = 'bbj_pool') OR (l.from_entity_id = p_pool_id AND l.from_type = 'bbj_pool'))
       AND l.created_at > v_base.taken_at AND l.created_at > v_prev.taken_at
       AND (l.to_label LIKE 'bbj_pools.%' OR l.from_label LIKE 'bbj_pools.%')
  ), banks AS (
    SELECT COALESCE(main_balance, 0) AS m, COALESCE(backup_balance, 0) AS b, COALESCE(promo_balance, 0) AS p
      FROM public.bbj_pools WHERE id = p_pool_id
  )
  SELECT banks.m, banks.b, banks.p, cumulative.m, cumulative.b, cumulative.p,
         recent.drops, recent.payouts, recent.sweeps, recent.funding, recent.moves
    INTO v_main, v_backup, v_promo, jm, jb, jp, v_drops, v_pay, v_sweep, v_fund, v_moves
    FROM banks CROSS JOIN cumulative CROSS JOIN recent;

