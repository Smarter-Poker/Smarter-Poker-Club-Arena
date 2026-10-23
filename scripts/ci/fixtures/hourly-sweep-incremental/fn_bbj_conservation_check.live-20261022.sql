CREATE OR REPLACE FUNCTION public.fn_bbj_conservation_check()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_in numeric; v_out numeric; v_bal numeric; v_gap numeric; v_base record;
  v_epoch_at timestamptz; v_epoch_unexp numeric; v_epoch_runs int;
  v_counters_paid numeric; v_payout_rows numeric; v_pre_table numeric;
  v_unrecorded_since numeric; v_seeds_live numeric;
  v_seeds numeric; v_drift numeric; v_unexplained numeric; v_tol numeric;
  v_absorbed numeric := 0; v_late_seeds numeric := 0; v_late_burns numeric := 0;
BEGIN
  v_in := fn_bbj_contributions_total();
  v_in := v_in + (SELECT COALESCE(SUM(amount),0) FROM union_wallet_transactions WHERE tx_type='bbj_fund');

  v_out := (SELECT COALESCE(SUM(total_amount),0) FROM bbj_payouts)
         + (SELECT COALESCE(SUM(amount),0) FROM union_wallet_transactions WHERE tx_type='bbj_promo_sweep')
         + (SELECT COALESCE(SUM(amount),0) FROM chip_transactions WHERE transaction_type='bbj_promo_sweep')
         + (SELECT COALESCE(SUM(amount),0) FROM wallet_transactions
             WHERE category='promotion' AND description='BBJ promo pool payout');

  /* A POOL OPENED AFTER THE EPOCH IS MEASURED FROM ITS OWN OPENING
     (2026-10-02, incident f3e82f59). fn_bbj_open_pool_baseline opens a later
     pool at GREATEST(created_at, epoch) and its opening balance already holds
     every leg up to that instant - the welcome seed leg has the pool's own
     created_at. Summing that baseline AND the journal since the global epoch
     counted each 100.00 seed twice. The legs a later pool's baseline absorbed
     are added back below; and its journalled seeds and burns enter the
     lifetime identity, because unlike the remembered 1,000.00 they have a
     ledger sentence. An ORIGINAL pool's seed or burn stays unexplained. */
  SELECT min(taken_at) INTO v_epoch_at FROM public.ca_bbj_pool_snapshots WHERE is_baseline;
  SELECT COALESCE(sum(x.absorbed), 0), COALESCE(sum(x.seeded), 0), COALESCE(sum(x.burned), 0)
    INTO v_absorbed, v_late_seeds, v_late_burns
    FROM (SELECT p.id AS pool_id, b.opened_at
            FROM public.bbj_pools p
            LEFT JOIN (SELECT s.pool_id, min(s.taken_at) AS opened_at
                         FROM public.ca_bbj_pool_snapshots s
                        WHERE s.is_baseline
                        GROUP BY s.pool_id) b ON b.pool_id = p.id
           WHERE COALESCE(b.opened_at, p.created_at) > v_epoch_at) o
    CROSS JOIN LATERAL (
      SELECT
        COALESCE(sum(CASE WHEN o.opened_at IS NOT NULL AND l.created_at <= o.opened_at
                          THEN (CASE WHEN l.to_type = 'bbj_pool' AND l.to_entity_id = o.pool_id THEN l.amount ELSE 0 END)
                             - (CASE WHEN l.from_type = 'bbj_pool' AND l.from_entity_id = o.pool_id THEN l.amount ELSE 0 END)
                          ELSE 0 END), 0) AS absorbed,
        COALESCE(sum(l.amount) FILTER (WHERE l.to_type = 'bbj_pool' AND l.to_entity_id = o.pool_id
                                         AND l.category <> 'bbj_contribution'), 0) AS seeded,
        COALESCE(sum(l.amount) FILTER (WHERE l.from_type = 'bbj_pool' AND l.from_entity_id = o.pool_id
                                         AND l.category NOT IN ('bbj_payout', 'promo')), 0) AS burned
        FROM public.chip_ledger l
       WHERE ((l.to_type = 'bbj_pool' AND l.to_entity_id = o.pool_id)
           OR (l.from_type = 'bbj_pool' AND l.from_entity_id = o.pool_id))
         AND l.created_at > v_epoch_at) x;
  v_in := v_in + v_late_seeds;
  v_out := v_out + v_late_burns;

  SELECT COALESCE(SUM(main_balance+backup_balance+promo_balance),0) INTO v_bal FROM bbj_pools;

  v_gap := round(v_in - v_out - v_bal, 2);
  SELECT * INTO v_base FROM bbj_conservation_baseline WHERE id = 1;
  v_tol := COALESCE(v_base.tolerance, 1.00);
  v_drift := round(v_gap - COALESCE(v_base.baseline_gap, 0), 2);

  -- THE EPOCH (Phase 4.2): since the opening balances, the journal identity per
  -- pool per bank. This is what `healthy` means; the lifetime figures stay.
  SELECT min(taken_at) INTO v_epoch_at FROM public.ca_bbj_pool_snapshots WHERE is_baseline;
  SELECT count(*) INTO v_epoch_runs FROM public.ca_bbj_pool_snapshots WHERE NOT is_baseline;
  /* END TO END, NOT INTERVAL BY INTERVAL (2026-09-09). Summing each hour's
     residue accumulated every straddled drop forever, because a leg whose
     transaction began before a snapshot and committed after it belongs to no
     window at all. One comparison across the whole epoch has only two
     boundaries instead of three hundred. */
  SELECT round(
           (SELECT COALESCE(sum(main_balance + backup_balance + promo_balance), 0) FROM public.bbj_pools)
         - (SELECT COALESCE(sum(b.main + b.backup + b.promo), 0)
              FROM public.ca_bbj_pool_snapshots b WHERE b.is_baseline)
         - (SELECT COALESCE(sum(CASE WHEN l.to_type = 'bbj_pool' THEN l.amount ELSE 0 END), 0)
                 - COALESCE(sum(CASE WHEN l.from_type = 'bbj_pool' THEN l.amount ELSE 0 END), 0)
              FROM public.chip_ledger l
             WHERE (l.to_type = 'bbj_pool' OR l.from_type = 'bbj_pool')
               AND l.created_at > v_epoch_at), 2)
    INTO v_epoch_unexp;
  v_epoch_unexp := round(v_epoch_unexp + v_absorbed, 2);

  /* THE LIFETIME DECOMPOSITION (phase 5.3). Two ledgers with different start
     dates, named rather than reported as a deficit.

     ROOT pools only: a merge folds the retired pool's counters into its
     destination, so summing every pool would count the club pool's 74,301.10
     twice. */
  SELECT COALESCE(sum(total_paid_out),0) INTO v_counters_paid
    FROM bbj_pools WHERE merged_into_pool_id IS NULL;
  SELECT COALESCE(sum(total_amount),0) INTO v_payout_rows FROM bbj_payouts;
  v_pre_table := round(v_counters_paid - v_payout_rows, 2);

  /* The historical figure is CLOSED at 71,749.31. Anything beyond it is a
     payout made since bbj_payouts existed that wrote no row - a live blind
     spot wearing a historical explanation's clothes. */
  v_unrecorded_since := round(v_pre_table - COALESCE(v_base.pre_ledger_payouts, 0), 2);

  /* Opening seeds pull the OTHER way: bank balance with no inflow row behind
     it. REMEMBERED, not read from bbj_pools.pool_amount - four functions can
     write that column, so deriving from it would let any of them move a money
     verdict, and would silently absorb a new seed the way the pre-ledger
     bucket would have absorbed a new unrecorded payout. The live column is
     reported beside it so a divergence is visible rather than load-bearing. */
  v_seeds := COALESCE(v_base.opening_seeds, 0);
  SELECT COALESCE(sum(pool_amount),0) INTO v_seeds_live FROM bbj_pools;

  v_unexplained := round(v_drift - v_pre_table + v_seeds, 2);

  RETURN jsonb_build_object(
    'inflow', round(v_in,2), 'outflow', round(v_out,2), 'balances', round(v_bal,2),
    'gap', v_gap,
    'baseline_gap', COALESCE(v_base.baseline_gap, 0),
    /* THE HEADLINE IS THE LIVE FIGURE (2026-09-09). This was v_drift, the
       lifetime gap, which is closed and does not move; the sweep reads this
       key for the incident's amount, so every incident said 70,795.11 while
       the thing that made the verdict unhealthy was a few chips. The
       lifetime figure keeps its place under 'lifetime' below. */
    'drift_from_baseline', round(COALESCE(v_epoch_unexp, 0), 2),
    'lifetime_drift_from_baseline', v_drift,
    'tolerance', v_tol,
    'lifetime', jsonb_build_object(
      'drift_from_baseline', v_drift,
      'paid_before_the_payout_table', v_pre_table,
      'pre_ledger_payouts_known', COALESCE(v_base.pre_ledger_payouts, 0),
      'paid_without_a_payout_row_since', v_unrecorded_since,
      'opening_seeds_known', v_seeds,
      'journalled_seeds_after_epoch', round(v_late_seeds, 2),
      'journalled_burns_after_epoch', round(v_late_burns, 2),
      'legacy_pool_amount_live', round(v_seeds_live,2),
      'unexplained', v_unexplained,
      'known_residue', COALESCE(v_base.lifetime_residue, 0),
      'moved_since_resolution', round(v_unexplained - COALESCE(v_base.lifetime_residue,0), 2),
      'note', 'The gap is two ledgers with different start dates, not missing chips. bbj_contributions begins 2026-03-03; bbj_payouts begins 2026-07-22. The union pool paid forty jackpots in between (71,749.31), and bbj_pools.total_paid_out is the witness that was there. Against it, 1,000.00 of opening seed sits in a bank with no contribution row. Both are CLOSED historical figures. `paid_without_a_payout_row_since` and `moved_since_resolution` are the live signals; everything else here is memory.'),
    'lifetime_healthy',
          abs(v_unexplained - COALESCE(v_base.lifetime_residue, 0)) <= v_tol
      AND abs(v_unrecorded_since) <= 0.01,
    'epoch', jsonb_build_object(
      'opened_at', v_epoch_at,
      'snapshots', v_epoch_runs,
      'unexplained_since_opening', round(v_epoch_unexp, 2),
      'absorbed_by_later_openings', round(v_absorbed, 2),
      'known_residue', COALESCE(v_base.epoch_residue, 0),
      'moved_since_recorded', round(v_epoch_unexp - COALESCE(v_base.epoch_residue, 0), 2)),
    'healthy', v_epoch_at IS NOT NULL
               AND abs(v_epoch_unexp - COALESCE(v_base.epoch_residue, 0)) <= v_tol);
END;
$function$;
