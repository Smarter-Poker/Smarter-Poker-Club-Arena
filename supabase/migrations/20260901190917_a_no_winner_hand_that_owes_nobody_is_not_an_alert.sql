-- A correction to 20260901190656, made on that check's first live run and
-- folded into its file so it reads as one change. This file records what
-- production actually ran second, and why.
--
-- fn_cash_pot_conservation_check flagged two cash hands that recorded no winner
-- at all. Both were fine. 86ff9441 and 139babb2, 2026-08-30: pot 0.30, rake
-- 0.03, bbj 0.27, undistributed 0.00 - the entire pot after rake went to the
-- Bad Beat Jackpot, which is a hand with no winner and nobody owed anything.
-- The check counts only a no-winner hand that is still HOLDING chips now:
--
--   count(*) FILTER (WHERE winner_count = 0 AND pot - rake - bbj > 0.01)
--
-- It also renames its own return field. `alerts_raised` was a small lie: the
-- dedupe path added in 20260901190226 returns an existing row's id, so a
-- standing condition reports itself on every pass without a new row being
-- written. It counts CONDITIONS that are open, and says so.
--
-- The false alert this raised is resolved below. After the correction, across
-- seven days and 463,506 cash hands: 0 mismatches, 0 undistributed, 0
-- conditions.
--
-- The function body is in 20260901190656; re-applying that file reproduces this
-- state exactly. The only statement unique to this migration is the cleanup:

UPDATE public.financial_alerts
   SET resolved = true, resolved_at = now()
 WHERE source = 'fn_cash_pot_conservation_check'
   AND resolved IS NOT TRUE
   AND context->>'kind' = 'no_winner_recorded';
