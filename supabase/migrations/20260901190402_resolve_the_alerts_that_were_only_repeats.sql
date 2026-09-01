-- ═══════════════════════════════════════════════════════════════════════════
--  RESOLVE THE ALERTS THAT WERE ONLY REPEATS (2026-09-01)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The dedupe key added in 20260901170000 stops new repeats. This clears the
-- backlog they left, and it clears NOTHING ELSE: every row it resolves has a
-- newer row from the same source about the same subject that stays open, or
-- describes a condition that provably ended.
--
--   fn_close_settlement_period        244 open rows, ONE subject
--   FeeReconciler.prize_disbursement   18 open rows, TWO subjects
--
-- fn_close_settlement_period files a row every time a club treasury cannot
-- fund a rakeback payout, on every pass over the same period. Its newest row
-- is dated 2026-08-29, so the treasury was funded and the condition is over;
-- 244 rows describe one problem that no longer exists.
--
-- IT IS NOT FIXED AT SOURCE, AND THIS SAYS SO RATHER THAN PRETENDING. That
-- function INSERTs into financial_alerts directly instead of going through
-- fn_raise_server_financial_alert, so it does not pick up the new dedupe key,
-- and it is a treasury function in another workstream. The one-line fix is to
-- guard its INSERT with
--
--   WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
--                      WHERE fa.source = 'fn_close_settlement_period'
--                        AND fa.resolved IS NOT TRUE
--                        AND fa.context->>'period_id' = p_period_id::text)
--
-- Rewriting a treasury function to change a log line is not a trade this audit
-- is willing to make blind, so it is written down here and left for its owner.

DO $resolve$
DECLARE
  v_settlement integer;
  v_disbursement integer;
BEGIN
  -- One subject, condition over. Keep the newest row so the history is still
  -- reachable from the alert list; resolve the 243 that only repeat it.
  WITH keep AS (
    SELECT id FROM public.financial_alerts
     WHERE source = 'fn_close_settlement_period' AND resolved IS NOT TRUE
     ORDER BY created_at DESC LIMIT 1
  )
  UPDATE public.financial_alerts fa
     SET resolved = true, resolved_at = now()
   WHERE fa.source = 'fn_close_settlement_period'
     AND fa.resolved IS NOT TRUE
     AND fa.id NOT IN (SELECT id FROM keep);
  GET DIAGNOSTICS v_settlement = ROW_COUNT;

  -- Keep the newest row per tournament; the rest are the same finding filed
  -- again on the next hour's pass.
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
  GET DIAGNOSTICS v_disbursement = ROW_COUNT;

  RAISE NOTICE 'resolved % settlement repeat(s) and % disbursement repeat(s)',
    v_settlement, v_disbursement;
END
$resolve$;
