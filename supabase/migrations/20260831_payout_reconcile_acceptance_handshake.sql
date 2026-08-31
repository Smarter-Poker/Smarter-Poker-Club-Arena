-- Repo copy of production migrations applied 2026-08-31 via Supabase MCP:
--   dans_ruling_on_the_two_double_payment_backlogs
--   payout_reconcile_acceptance_handshake
-- See docs/changelog/2026-08-31-phase3-the-settler-was-asked-an-o-week-question.md
--
-- 1. DAN'S RULING. Both double-payment backlogs were filed with
--    decision_owner "Dan" because reversing credits players have already been
--    shown is not an agent's call: tournament_double_payment_backlog
--    (18,201.60, the Sunday $200 reset replay) and
--    mystery_bounty_double_pay_backlog (156.40). Dan, verbatim:
--    "IM NOT WORRIED ABOUT ANY DOUBLE PAYMENTS OR ACCURACY WE ARE BETA
--    TESTING, AS LONG AS THE LEAK OR BUG IS FIXED". No clawback; closed as
--    DECIDED rather than left open as undecided. The amounts and causes stay
--    on the rows and in tournament_conservation_baseline.
--
-- 2. A HANDSHAKE I LEFT HALF-DONE. fn_tournament_payout_reconcile already
--    knows how not to nag: it suppresses a re-raise when the findings are
--    only overpaid/no_finisher_recorded, nothing is owed, AND a resolved
--    alert for that tournament carries a 'resolution' key. When I resolved
--    these earlier I set resolved/resolved_at and nothing else, so the
--    suppressor could never engage. That was invisible while
--    fn_tournament_payout_sweep died on its 8s ceiling every run — nothing
--    called the reconciler. Fixing the ceiling turned the sweep on for the
--    first time and the accepted overpayments began re-raising every cycle.
--    A fix that produces a permanent alert loop is not finished.
--
--    Verified after: an APPLY sweep over 2 days reports 3 findings and raises
--    ZERO new alerts (open 0 before, 0 after). The suppressor stays narrow —
--    any underpayment or outstanding top-up re-raises regardless.

UPDATE public.financial_alerts
   SET resolved = true, resolved_at = now(),
       context = COALESCE(context, '{}'::jsonb) || jsonb_build_object(
         'decision', 'NO CLAWBACK — Dan, 2026-08-31, verbatim: "IM NOT WORRIED ABOUT ANY DOUBLE PAYMENTS OR ACCURACY WE ARE BETA TESTING, AS LONG AS THE LEAK OR BUG IS FIXED". Closed as decided, not as unnoticed; the amount and cause remain on this row.',
         'decided_at', now())
 WHERE resolved IS NOT TRUE
   AND source IN ('tournament_double_payment_backlog', 'mystery_bounty_double_pay_backlog');

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
  IF n_open > 0 THEN RAISE EXCEPTION '% payout-reconcile alert(s) still open', n_open; END IF;

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
