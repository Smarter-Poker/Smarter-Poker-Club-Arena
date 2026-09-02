-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901193047; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- Two sets of open criticals describe work that is finished. Neither is closed
-- on a judgement call: in both cases the check that raised them now returns
-- clean, and that is the evidence.
--
-- 1. fn_detect_results_without_a_hand raised four criticals on 2026-09-01 for
--    tournaments that carried finishing places with no hand in hand_history.
--    Migration 20260901130906 (another agent, same day) unwound those four
--    events. The detector run immediately before this migration returns
--    flagged 0, tournament_ids [], parked_completing 0.
--
-- 2. FeeReconciler.prize_disbursement's duplicates. The per-tournament dedupe
--    key landed in 20260901190226 and the backlog was cut in 20260901190402;
--    this catches the handful raised in the window between the two, keeping
--    the newest row per tournament so the finding itself stays open. Those
--    findings are REAL and are not being closed - only their repeats are.
--
-- What is deliberately NOT closed here: the twelve fn_tournament_payout_reconcile
-- criticals. They are true, they are new, and they are new BECAUSE of this
-- audit. Completing the payout record in 20260901134250 gave the reconciler the
-- full picture of what had already been paid, and the picture shows historical
-- OVERpayments that the incomplete record had been hiding - 65 events and
-- 19,665.23 chips over 120 days, measured against the wallet. Nobody is short.
-- Under Dan's ruling of 2026-08-28 there is no clawback from players, so these
-- stay open as a club-cost decision rather than being quietly resolved by the
-- agent whose backfill surfaced them.

DO $close$
DECLARE v_nohand integer; v_disb integer;
BEGIN
  UPDATE public.financial_alerts
     SET resolved = true, resolved_at = now()
   WHERE source = 'fn_detect_results_without_a_hand'
     AND resolved IS NOT TRUE;
  GET DIAGNOSTICS v_nohand = ROW_COUNT;

  WITH ranked AS (
    SELECT fa.id,
           row_number() OVER (
             PARTITION BY COALESCE(fa.context->>'tournament_id', fa.message)
             ORDER BY fa.created_at DESC) AS rn
      FROM public.financial_alerts fa
     WHERE fa.source = 'FeeReconciler.prize_disbursement'
       AND fa.resolved IS NOT TRUE
  )
  UPDATE public.financial_alerts fa
     SET resolved = true, resolved_at = now()
    FROM ranked r
   WHERE fa.id = r.id AND r.rn > 1;
  GET DIAGNOSTICS v_disb = ROW_COUNT;

  RAISE NOTICE 'closed % no-hand finding(s) and % disbursement repeat(s)', v_nohand, v_disb;
END
$close$;
