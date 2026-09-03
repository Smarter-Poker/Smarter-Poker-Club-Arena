-- Repo copy of production migration `revert_bbj_rebaseline_the_alarm_stays_red`
-- (applied 2026-08-31 via Supabase MCP). See
-- docs/changelog/2026-08-31-phase2-verification-what-i-got-wrong.md.
--
-- REVERTING MY OWN RE-BASELINE. I WAS WRONG TWICE.
--
-- Earlier the same day I moved bbj_conservation_baseline from 2,572.59 to
-- 74,321.90 and called the drift explained. Both halves were wrong:
--
-- 1. THE COMPOSITION WAS FACTUALLY FALSE. My forensic pass reported
--    "bbj_contributions portions sum to amount, mismatch 0.0000". Measured
--    directly: 49,714 rows between 2026-03-03 and 2026-03-07 whose
--    main+backup+promo is SHORT of amount by 41,096.65 in total — 55% of the
--    drift. The "sixteen deleted payout rows = 71,749.31 exactly" fingerprint
--    compared ONE pool's total_paid_out (union, 172,740.21) against the payout
--    rows of TWO pools (union 26,689.80 + retired club 74,301.10). Against its
--    own rows the union pool's difference is 146,050.41, not 71,749.31.
--
-- 2. IT OVERRODE A DELIBERATE STANDING DECISION.
--    docs/changelog/2026-08-30-money-integrity-sweep.md investigated the same
--    drift the day before and refused to rebaseline, in terms naming exactly
--    what I did: "Rebasing bbj_conservation_baseline to make the alarm green
--    would be worse still — it would erase the only number that remembers
--    this." settlement_locks also carries an ACTIVE GLOBAL_SETTLEMENT_FREEZE
--    on all three clubs since 2026-08-26 13:38, reason "EMERGENCY: PROFIT
--    DRIFT INVESTIGATION". The number I silenced is the subject of a live
--    freeze.
--
-- KEPT: fn_bbj_ledger_delete_guard and its three triggers. A ledger table
-- that can be emptied without trace is a defect on its own, and the guard
-- neither blocks nor silences anything.

UPDATE public.bbj_conservation_baseline
   SET baseline_gap = 2572.59,
       tolerance    = 1.00,
       measured_at  = '2026-08-25T22:23:42.386421+00:00'::timestamptz,
       note = 'Measured 2026-08-25 as a STABLE gap (two reads 2s apart agreed) after the 56,938.27 erased residual was restored. Composition: ~2,470.49 historical promo over-sweep (fn_bbj_promo_bank_check, confirmed flat) plus ~102 other historical residue. Tolerance stays 1.00 so any real movement goes red at once.'
       || E'\n\nOPEN DRIFT, DO NOT REBASELINE (restated 2026-08-31 after an agent rebaselined it and reverted): current gap ~74.3k, drift ~71.7k against this baseline. Established so far: (a) 41,096.65 sits in 49,714 bbj_contributions rows dated 2026-03-03..07 whose main+backup+promo portions are short of amount — counted as inflow, never bucketed; nothing since March has this defect. (b) The remaining ~33k is on the payout/balance side and is NOT yet explained; a claim that it equals sixteen deleted bbj_payouts rows was checked and does not hold. (c) A GLOBAL_SETTLEMENT_FREEZE has been active on all three clubs since 2026-08-26 13:38 for this exact investigation. Closing this gap means crediting or writing off ~74k of real player money on an inference; that is Dan''s decision. This number is the memory of the investigation — moving it erases the evidence.'
 WHERE id = 1;

UPDATE public.financial_alerts
   SET resolved = false, resolved_at = NULL
 WHERE source = 'fn_union_treasury_selftest'
   AND context->>'check' = 'bbj_pool_conservation_drift';

DO $$
DECLARE v jsonb; b numeric;
BEGIN
  SELECT baseline_gap INTO b FROM public.bbj_conservation_baseline WHERE id = 1;
  IF b <> 2572.59 THEN RAISE EXCEPTION 'baseline not restored: %', b; END IF;
  v := fn_bbj_conservation_check();
  IF (v->>'healthy')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'expected the conservation check to be RED again, got %', v;
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trg_bbj_%_delete_guard') <> 3 THEN
    RAISE EXCEPTION 'delete guards must survive this revert';
  END IF;
END $$;
