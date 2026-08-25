-- A POOL WHOSE RESIDUAL HAS BEEN PAID BACK IS NOT STILL ERASED (2026-08-25)
--
-- fn_bbj_gap_decomposition explains part of the conservation gap as
-- "merged_pool_residual_erased": money zeroed out of a retired pool without the
-- destination being credited. Its rule is "merged_into_pool_id IS NOT NULL and
-- the balances are zero", and that stays true of a settled source pool forever.
--
-- Pool 0867a7fd's residual was restored on 2026-08-25 (56,938.27 into
-- f9806a7f). The measured gap fell from 59,178.82 to 2,240.55, exactly the
-- amount returned. But the decomposition still counted that pool as erased, so
-- it reported the restoration as a fresh 54,697.72 discrepancy in the opposite
-- direction.
--
-- A check that reports a fixed thing as broken is worse than no check, because
-- the next real regression arrives inside noise nobody reads any more.
--
-- One change: skip pools listed in bbj_pool_restorations. Nothing else about
-- the arithmetic moves, and a pool that has NOT been restored is still counted
-- exactly as before.
--
-- ROLLBACK: restore the previous body from
-- 20260823204045_bbj_conservation_honest_baseline.

CREATE OR REPLACE FUNCTION public.fn_bbj_gap_decomposition()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $fn$
DECLARE
    v_check      jsonb;
    v_orphan     numeric := 0;
    v_orphan_pre numeric := 0;
    v_restored   numeric := 0;
BEGIN
    v_check := public.fn_bbj_conservation_check();

    SELECT COALESCE(sum(
             COALESCE(c.contributed,0)
           - COALESCE(p.paid,0)
           - COALESCE(s.swept,0)
           - COALESCE(b.main_balance,0)
           - COALESCE(b.backup_balance,0)
           - COALESCE(b.promo_balance,0)), 0)
      INTO v_orphan
      FROM bbj_pools b
      LEFT JOIN (SELECT pool_id, sum(amount) contributed FROM bbj_contributions GROUP BY 1) c
             ON c.pool_id = b.id
      LEFT JOIN (SELECT pool_id, sum(total_amount) paid FROM bbj_payouts GROUP BY 1) p
             ON p.pool_id = b.id
      LEFT JOIN (SELECT (SELECT COALESCE(sum(amount),0) FROM chip_transactions
                          WHERE transaction_type='bbj_promo_sweep') AS swept) s ON true
     WHERE b.merged_into_pool_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.bbj_pool_restorations r
                        WHERE r.source_pool_id = b.id);

    SELECT COALESCE(sum(bc.amount),0) INTO v_orphan_pre
      FROM bbj_contributions bc
     WHERE bc.main_portion IS NULL AND bc.backup_portion IS NULL AND bc.promo_portion IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.bbj_pool_restorations r
                        WHERE r.source_pool_id = bc.pool_id);

    SELECT COALESCE(sum(amount),0) INTO v_restored FROM public.bbj_pool_restorations;

    RETURN jsonb_build_object(
        'measured_gap',        v_check -> 'gap',
        'baseline_gap',        v_check -> 'baseline_gap',
        'drift_from_baseline', v_check -> 'drift_from_baseline',
        'healthy',             v_check -> 'healthy',
        'restored_to_pools',   round(v_restored, 2),
        'explained', jsonb_build_object(
            'merged_pool_residual_erased', round(v_orphan, 2),
            'of_which_pre_triple_bank',    round(v_orphan_pre, 2),
            'note', 'Retired pools whose merged_into_pool_id is set were zeroed without the destination being credited. Pools listed in bbj_pool_restorations have had that residual paid back and are excluded.'),
        'remainder_unexplained',
            round(((v_check ->> 'gap')::numeric) - v_orphan, 2)
    );
END $fn$;
