CREATE OR REPLACE FUNCTION public.fn_bbj_promo_facts(p_pool_id uuid)
 RETURNS TABLE(is_operator boolean, purse_kind text, purse_available numeric, pool_staged numeric, contributed_all_time numeric, swept_all_time numeric, observed_rate_pct numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH pool AS (
    SELECT bp.id, bp.club_id, bp.union_id, COALESCE(bp.promo_balance, 0) AS staged
      FROM public.bbj_pools bp WHERE bp.id = p_pool_id
  ),
  caller AS (
    SELECT (auth.uid() IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.clubs c, pool
               WHERE (c.id = pool.club_id
                      OR (pool.union_id IS NOT NULL AND c.union_id = pool.union_id))
                 AND public.fn_is_club_admin_uid(c.id)
            )) AS is_operator
  ),
  purse AS (
    SELECT
      CASE WHEN pool.union_id IS NOT NULL THEN 'union' ELSE 'club' END AS kind,
      CASE WHEN pool.union_id IS NOT NULL
           THEN (SELECT COALESCE(uw.promo_wallet, 0) FROM public.union_wallets uw
                  WHERE uw.union_id = pool.union_id)
           ELSE (SELECT COALESCE(c.promo_balance, 0) FROM public.clubs c
                  WHERE c.id = pool.club_id)
      END AS available
      FROM pool
  ),
  flow AS (
    SELECT
      COALESCE((SELECT sum(x.promo_portion) FROM public.bbj_contributions x
                 WHERE x.pool_id = p_pool_id), 0) AS contributed,
      COALESCE((SELECT sum(t.amount) FROM public.union_wallet_transactions t, pool
                 WHERE t.tx_type = 'bbj_promo_sweep'
                   AND pool.union_id IS NOT NULL AND t.union_id = pool.union_id), 0)
      + COALESCE((SELECT sum(t.amount) FROM public.chip_transactions t, pool
                   WHERE t.transaction_type = 'bbj_promo_sweep'
                     AND pool.union_id IS NULL AND t.club_id = pool.club_id), 0) AS swept,
      (SELECT CASE WHEN COALESCE(sum(x.amount), 0) > 0
                   THEN COALESCE(sum(x.promo_portion), 0) / sum(x.amount) * 100
                   ELSE 0 END
         FROM public.bbj_contributions x
        WHERE x.pool_id = p_pool_id AND x.promo_portion IS NOT NULL) AS rate
  )
  SELECT caller.is_operator,
         CASE WHEN caller.is_operator THEN purse.kind END,
         CASE WHEN caller.is_operator THEN ROUND(purse.available, 2) END,
         CASE WHEN caller.is_operator THEN ROUND(pool.staged, 2) END,
         CASE WHEN caller.is_operator THEN ROUND(flow.contributed, 2) END,
         CASE WHEN caller.is_operator THEN ROUND(flow.swept, 2) END,
         CASE WHEN caller.is_operator THEN ROUND(flow.rate, 2) END
    FROM pool, caller, purse, flow;
$function$
