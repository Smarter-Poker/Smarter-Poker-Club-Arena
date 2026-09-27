CREATE OR REPLACE FUNCTION public.fn_bbj_reconcile(p_pool_id uuid)
 RETURNS ca_bbj_pool_snapshots
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prev public.ca_bbj_pool_snapshots%ROWTYPE;
  v_base public.ca_bbj_pool_snapshots%ROWTYPE;
  v_now timestamptz := clock_timestamp();  -- not now(): two runs in one transaction must not collide
  v_main numeric; v_backup numeric; v_promo numeric;
  jm numeric := 0; jb numeric := 0; jp numeric := 0;
  v_drops numeric := 0; v_pay numeric := 0; v_sweep numeric := 0; v_fund numeric := 0; v_moves numeric := 0;
  v_fail integer := 0;
  v_row public.ca_bbj_pool_snapshots%ROWTYPE;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_bbj_reconcile is service only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_prev FROM public.ca_bbj_pool_snapshots WHERE pool_id = p_pool_id ORDER BY taken_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fn_bbj_reconcile: pool % has no opening balance; write the baseline first', p_pool_id;
  END IF;
  SELECT * INTO v_base FROM public.ca_bbj_pool_snapshots
   WHERE pool_id = p_pool_id AND is_baseline ORDER BY taken_at LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fn_bbj_reconcile: pool % has no opening balance row', p_pool_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bbj_pools WHERE id = p_pool_id) THEN
    RAISE EXCEPTION 'fn_bbj_reconcile: pool % not found', p_pool_id;
  END IF;

  -- ONE STATEMENT, ONE SNAPSHOT: the banks and the legs are read together so
  -- a write that commits between two reads cannot show in one and not the
  -- other. Every leg the autoledger wrote for this pool's own columns since the
  -- previous snapshot: the labelled side is the pool's bank, its sign is the
  -- side the label sits on (a bank move is two self-legs, one label each).
  -- A leg where the pool is only somebody else's counterparty carries no
  -- bbj_pools label and moves no bank, so it is not counted.
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


  SELECT count(*) INTO v_fail FROM public.ca_ledger_write_failures f
   WHERE f.occurred_at > v_prev.taken_at AND f.occurred_at <= v_now AND f.message ILIKE '%bbj_pools.%';

  INSERT INTO public.ca_bbj_pool_snapshots
    (pool_id, taken_at, is_baseline, prev_id, main, backup, promo,
     journal_main, journal_backup, journal_promo,
     drops_since, payouts_since, sweeps_since, funding_since, moves_since, write_failures,
     unexplained_main, unexplained_backup, unexplained_promo, basis_version)
  VALUES
    (p_pool_id, v_now, false, v_prev.id, v_main, v_backup, v_promo,
     round(jm, 2), round(jb, 2), round(jp, 2),
     round(v_drops, 2), round(v_pay, 2), round(v_sweep, 2), round(v_fund, 2), round(v_moves, 2), v_fail,
     -- CUMULATIVE SINCE THE OPENING BALANCE, not since the last reading:
     -- a boundary shows up once and is gone by the next run, a leak grows.
     round((v_main - v_base.main) - jm, 2),
     round((v_backup - v_base.backup) - jb, 2),
     round((v_promo - v_base.promo) - jp, 2),
     -- THE READING SAYS WHAT IT MEASURED. Change the arithmetic above and
     -- change this string with it: fn_bbj_reconcile_all refuses to call a
     -- reading growth when the reading before it was taken on another basis.
     'cumulative-since-open-v1')
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$
