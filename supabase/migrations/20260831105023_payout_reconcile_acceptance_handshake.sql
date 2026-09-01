-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831105023; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- CLOSING A HANDSHAKE I LEFT HALF-DONE
--
-- fn_tournament_payout_reconcile already knows how not to nag. It suppresses
-- a re-raise when the findings are only 'overpaid'/'no_finisher_recorded',
-- there is nothing to top up, AND a previously RESOLVED alert for that
-- tournament carries a 'resolution' key:
--
--   v_was_accepted := EXISTS (SELECT 1 FROM financial_alerts
--     WHERE source='fn_tournament_payout_reconcile' AND resolved IS TRUE
--       AND context->>'tournament_id' = p_tournament_id::text
--       AND context ? 'resolution');
--
-- When I resolved these alerts earlier today I set resolved/resolved_at and
-- nothing else, so `context ? 'resolution'` was false and the suppressor could
-- never engage. It did not matter while fn_tournament_payout_sweep was dying
-- on its 8s ceiling every run — nothing was calling the reconciler. Fixing the
-- ceiling turned the sweep on for the first time, and the same two accepted
-- overpayments began re-raising every cycle. A fix that produces a permanent
-- alert loop is not finished.
--
-- Stamps the resolution the author's design asks for. The suppressor stays
-- narrow: any UNDERPAYMENT, or any top-up still owed, re-raises regardless of
-- what was accepted before. Historical alerts for events outside the sweep's
-- window are left exactly as they are — nothing re-scans them, and rewriting
-- 142 old rows to satisfy an assertion would be tidying, not fixing.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE public.financial_alerts fa
   SET resolved = true,
       resolved_at = COALESCE(fa.resolved_at, now()),
       context = COALESCE(fa.context, '{}'::jsonb) || jsonb_build_object(
         'resolution',
         'Accepted 2026-08-31. Overpayment only, nothing owed to anyone, and the excess is recorded in tournament_conservation_baseline with its cause. Dan, verbatim: "IM NOT WORRIED ABOUT ANY DOUBLE PAYMENTS OR ACCURACY WE ARE BETA TESTING, AS LONG AS THE LEAK OR BUG IS FIXED". This key is the handshake fn_tournament_payout_reconcile reads to stop re-raising; an underpayment or an outstanding top-up still re-raises.')
 WHERE fa.source = 'fn_tournament_payout_reconcile'
   AND NOT (fa.context ? 'resolution')
   AND EXISTS (SELECT 1 FROM public.tournament_conservation_baseline b
                WHERE b.tournament_id::text = fa.context->>'tournament_id');

UPDATE public.financial_alerts fa
   SET resolved = true,
       resolved_at = COALESCE(fa.resolved_at, now()),
       context = COALESCE(fa.context, '{}'::jsonb) || jsonb_build_object(
         'resolution',
         'Accepted 2026-08-31: a rounding epsilon of at most 0.01 on a single place, which this function reports and by its own design never claws back.')
 WHERE fa.source = 'fn_tournament_payout_reconcile'
   AND NOT (fa.context ? 'resolution')
   AND fa.created_at > now() - interval '30 days'
   AND (fa.context->'issues'->0->>'excess')::numeric <= 0.01;

DO $$
DECLARE n_open int; n_blind int;
BEGIN
  SELECT count(*) INTO n_open FROM public.financial_alerts
   WHERE source = 'fn_tournament_payout_reconcile' AND resolved IS NOT TRUE;
  IF n_open > 0 THEN
    RAISE EXCEPTION '% payout-reconcile alert(s) still open', n_open;
  END IF;

  -- The assertion that matters: every event the sweep still SEES and would
  -- accept must carry the handshake, or it re-raises on the next cycle.
  SELECT count(*) INTO n_blind
    FROM public.tournament_conservation_baseline b
    JOIN public.tournaments t ON t.id = b.tournament_id
   WHERE t.status = 'COMPLETED'
     AND COALESCE(t.ended_at, t.started_at) > now() - interval '30 days'
     AND EXISTS (SELECT 1 FROM public.financial_alerts fa
                  WHERE fa.source = 'fn_tournament_payout_reconcile'
                    AND fa.context->>'tournament_id' = b.tournament_id::text)
     AND NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                      WHERE fa.source = 'fn_tournament_payout_reconcile'
                        AND fa.resolved IS TRUE
                        AND fa.context->>'tournament_id' = b.tournament_id::text
                        AND fa.context ? 'resolution');
  IF n_blind > 0 THEN
    RAISE EXCEPTION '% acknowledged in-window event(s) still lack the handshake and will re-raise', n_blind;
  END IF;
END $$;

