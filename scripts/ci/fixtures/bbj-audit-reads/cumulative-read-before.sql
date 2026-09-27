  WITH legs AS (
    SELECT l.category,
           CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.amount
                WHEN l.from_label LIKE 'bbj_pools.%' THEN -l.amount ELSE 0 END AS signed,
           (l.created_at > v_prev.taken_at) AS in_interval,
           CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.to_label
                WHEN l.from_label LIKE 'bbj_pools.%' THEN l.from_label END AS lbl,
           l.amount, l.from_type, l.to_type
      FROM public.chip_ledger l
     WHERE ((l.to_entity_id = p_pool_id AND l.to_type = 'bbj_pool') OR (l.from_entity_id = p_pool_id AND l.from_type = 'bbj_pool'))
       -- FROM THE OPENING BALANCE, NOT THE LAST READING: a leg that
       -- straddles one reading is inside the next, instead of falling
       -- between two windows and never being counted at all. No upper
       -- bound: this statement's own snapshot is the bound.
       AND l.created_at > v_base.taken_at
       AND (l.to_label LIKE 'bbj_pools.%' OR l.from_label LIKE 'bbj_pools.%')
  )
  , banks AS (
    SELECT COALESCE(main_balance, 0) AS m, COALESCE(backup_balance, 0) AS b, COALESCE(promo_balance, 0) AS p
      FROM public.bbj_pools WHERE id = p_pool_id
  )
  SELECT banks.m, banks.b, banks.p,
         COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.main_balance'), 0),
         COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.backup_balance'), 0),
         COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.promo_balance'), 0),
         COALESCE(sum(amount) FILTER (WHERE in_interval AND category = 'bbj_contribution' AND to_type = 'bbj_pool' AND from_type <> 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE in_interval AND category = 'bbj_payout' AND from_type = 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE in_interval AND category = 'promo' AND from_type = 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE in_interval AND category = 'transfer' AND to_type = 'bbj_pool'), 0),
         COALESCE(sum(amount) FILTER (WHERE in_interval AND from_type = 'bbj_pool' AND to_type = 'bbj_pool'), 0) / 2
    INTO v_main, v_backup, v_promo, jm, jb, jp, v_drops, v_pay, v_sweep, v_fund, v_moves
    FROM banks LEFT JOIN legs ON true
   GROUP BY banks.m, banks.b, banks.p;

