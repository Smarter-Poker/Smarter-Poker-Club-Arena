-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831101331; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- The settler-lag alert, resolved on live evidence rather than assertion.
--
-- Before (2026-08-31 09:5x): cursor 2026-08-30 05:37, lag 28.3h, backlog
-- 32,922 and growing ~574/hour, every cycle logging
-- "Settled 0/221 period rows ... in 67838ms (failures: 221)".
--
-- After the daily-rollup rewrite: "Settled 227/227 ... in 14483ms
-- (failures: 0)", then 213/213 in 15500ms, and the cursor walked forward
-- through a day of history in fifteen minutes. fn_settler_lag_check() now
-- reports healthy.
--
-- Gated on the check itself: if the settler is not actually healthy at the
-- moment this runs, nothing is resolved.
UPDATE public.financial_alerts
   SET resolved = true, resolved_at = now(),
       context = COALESCE(context, '{}'::jsonb) || jsonb_build_object(
         'resolution',
         'fn_rakeback_recompute_periods was O(week) per settler page: 28.4s for one club-day on the old per-row path, ~400s for the week, against a 60s client deadline. Rewritten set-based over rake_attributions plus a per-(club,day) rollup — a club-day is now 4.6s and a full week 7.5s. Verified identical money math first (406 users over 6h, zero differing cents; 564 users / 6,089,636 cents over a full day). Settler drained from 32,922 backlog rows to healthy.')
 WHERE source = 'fn_union_treasury_selftest'
   AND resolved IS NOT TRUE
   AND context->>'check' = 'rakeback_settler_lagging'
   AND (SELECT (fn_settler_lag_check()->>'healthy')::boolean) IS TRUE;

DO $$
BEGIN
  IF (SELECT (fn_settler_lag_check()->>'healthy')::boolean) IS TRUE
     AND EXISTS (SELECT 1 FROM public.financial_alerts
                  WHERE source = 'fn_union_treasury_selftest'
                    AND resolved IS NOT TRUE
                    AND context->>'check' = 'rakeback_settler_lagging') THEN
    RAISE EXCEPTION 'settler is healthy but its lag alert is still open';
  END IF;
END $$;

