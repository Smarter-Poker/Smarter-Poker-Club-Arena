-- Synthetic ids only. Each case names the one property it isolates.
DO $cases$
DECLARE
  w uuid := '00000000-0000-4000-8000-0000000000aa';
  w_other uuid := '00000000-0000-4000-8000-0000000000bb'; -- a different winner
  t_paid      uuid := '10000000-0000-4000-8000-000000000001'; -- COMPLETED, receipt, paid
  t_unknown   uuid := '10000000-0000-4000-8000-000000000002'; -- same, unknown-outcome alert
  t_running   uuid := '10000000-0000-4000-8000-000000000003'; -- still RUNNING, no receipt
  t_unpaid    uuid := '10000000-0000-4000-8000-000000000004'; -- receipt, one payout unpaid
  t_short     uuid := '10000000-0000-4000-8000-000000000005'; -- receipt, payout total differs
  t_noreceipt uuid := '10000000-0000-4000-8000-000000000006'; -- COMPLETED but no receipt
  t_sat       uuid := '10000000-0000-4000-8000-000000000007'; -- satellite source, out of scope
  t_otherwin  uuid := '10000000-0000-4000-8000-000000000008'; -- paid receipt, but for another winner
  t_nowinner  uuid := '10000000-0000-4000-8000-000000000009'; -- paid receipt, alert names no winner
  v jsonb;
  n integer;
BEGIN
  INSERT INTO public.tournaments(id, name, status, ended_at) VALUES
    (t_paid, 'paid', 'COMPLETED', now()), (t_unknown, 'unknown', 'COMPLETED', now()),
    (t_running, 'running', 'RUNNING', NULL), (t_unpaid, 'unpaid', 'COMPLETED', now()),
    (t_short, 'short', 'COMPLETED', now()), (t_noreceipt, 'noreceipt', 'COMPLETED', now()),
    (t_sat, 'sat', 'COMPLETED', now()), (t_otherwin, 'otherwin', 'COMPLETED', now()),
    (t_nowinner, 'nowinner', 'COMPLETED', now());
  INSERT INTO public.tournament_terminal_settlements
    (tournament_id, winner_id, settlement_mode, cash_payout_count, cash_payout_total, completed_at) VALUES
    (t_paid, w, 'places', 1, 95.00, now()), (t_unknown, w, 'places', 2, 150.00, now()),
    (t_unpaid, w, 'places', 1, 19.00, now()), (t_short, w, 'places', 1, 38.00, now()),
    (t_sat, w, 'places', 1, 10.00, now()), (t_otherwin, w_other, 'places', 1, 12.00, now()),
    (t_nowinner, w, 'places', 1, 14.00, now());
  INSERT INTO public.tournament_payouts(tournament_id, user_id, position, amount, paid_at) VALUES
    (t_paid, w, 1, 95.00, now()),
    (t_unknown, w, 1, 100.00, now()), (t_unknown, gen_random_uuid(), 2, 50.00, now()),
    (t_unpaid, w, 1, 19.00, NULL),
    (t_short, w, 1, 37.99, now()),
    (t_noreceipt, w, 1, 5.00, now()),
    (t_sat, w, 1, 10.00, now()),
    (t_otherwin, w_other, 1, 12.00, now()),
    (t_nowinner, w, 1, 14.00, now());

  INSERT INTO public.financial_alerts(severity, source, message, context) VALUES
    ('critical', 'Tournament.atomic_finish_refused', 'case paid',
       jsonb_build_object('tournament_id', t_paid, 'winner_id', w, 'refusal_reason', 'timeout', 'case', 'paid')),
    ('critical', 'Tournament.atomic_finish_outcome_unknown', 'case unknown',
       jsonb_build_object('tournament_id', t_unknown, 'winner_id', upper(w::text), 'case', 'unknown')),
    ('critical', 'Tournament.atomic_finish_refused', 'case running',
       jsonb_build_object('tournament_id', t_running, 'winner_id', w, 'refusal_reason', 'timeout', 'case', 'running')),
    ('critical', 'Tournament.atomic_finish_refused', 'case unpaid',
       jsonb_build_object('tournament_id', t_unpaid, 'winner_id', w, 'refusal_reason', 'timeout', 'case', 'unpaid')),
    ('critical', 'Tournament.atomic_finish_refused', 'case short',
       jsonb_build_object('tournament_id', t_short, 'winner_id', w, 'refusal_reason', 'timeout', 'case', 'short')),
    ('critical', 'Tournament.atomic_finish_refused', 'case noreceipt',
       jsonb_build_object('tournament_id', t_noreceipt, 'winner_id', w, 'refusal_reason', 'timeout', 'case', 'noreceipt')),
    ('critical', 'Tournament.atomic_finish_refused', 'case malformed',
       jsonb_build_object('tournament_id', 'not-a-uuid', 'winner_id', w, 'case', 'malformed')),
    ('critical', 'Tournament.atomic_satellite_finish_refused', 'case satellite',
       jsonb_build_object('tournament_id', t_sat, 'winner_id', w, 'case', 'satellite')),
    -- The receipt settled and paid, but for a different winner than the one
    -- this alert named: the alert's own subject is not proven met.
    ('critical', 'Tournament.atomic_finish_refused', 'case otherwin',
       jsonb_build_object('tournament_id', t_otherwin, 'winner_id', w, 'refusal_reason', 'timeout', 'case', 'otherwin')),
    ('critical', 'Tournament.atomic_finish_refused', 'case nowinner',
       jsonb_build_object('tournament_id', t_nowinner, 'refusal_reason', 'timeout', 'case', 'nowinner')),
    ('critical', 'Tournament.atomic_finish_refused', 'case badwinner',
       jsonb_build_object('tournament_id', t_nowinner, 'winner_id', 'not-a-uuid', 'refusal_reason', 'timeout', 'case', 'badwinner'));

  -- A preview changes nothing.
  v := public.fn_resolve_settled_financial_alerts(false, 5000);
  SELECT count(*) INTO n FROM public.financial_alerts WHERE resolved;
  IF n <> 0 THEN RAISE EXCEPTION 'preview resolved % row(s)', n; END IF;

  v := public.fn_resolve_settled_financial_alerts(true, 5000);
  RAISE NOTICE 'apply result %', v;

  -- The two settled finishes close, with the receipt named on the row.
  IF EXISTS (SELECT 1 FROM public.financial_alerts
              WHERE context->>'case' IN ('paid', 'unknown') AND NOT resolved) THEN
    RAISE EXCEPTION 'a retried finish whose terminal receipt settled and paid is still open';
  END IF;
  IF EXISTS (SELECT 1 FROM public.financial_alerts
              WHERE context->>'case' IN ('paid', 'unknown')
                AND (resolution IS NULL OR resolved_at IS NULL
                     OR context->'terminal_receipt_v1'->>'kind' IS DISTINCT FROM 'finish_committed_after_alert'
                     OR context->>'resolved_by_fn' IS DISTINCT FROM 'fn_resolve_settled_financial_alerts')) THEN
    RAISE EXCEPTION 'a closed finish alert does not carry its receipt evidence';
  END IF;
  IF (v->>'finish_committed_after_alert')::int IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'resolver reported % finish closure(s), expected 2', v->>'finish_committed_after_alert';
  END IF;

  -- Everything that is not proven met stays open for a person.
  SELECT count(*) INTO n FROM public.financial_alerts
   WHERE context->>'case' IN ('running', 'unpaid', 'short', 'noreceipt', 'malformed', 'satellite',
                              'otherwin', 'nowinner', 'badwinner')
     AND NOT resolved;
  IF n <> 9 THEN
    RAISE EXCEPTION 'expected 9 unproven finish alerts to stay open, % did', n;
  END IF;
  IF NOT (SELECT resolved IS FALSE FROM public.financial_alerts WHERE context->>'case' = 'otherwin') THEN
    RAISE EXCEPTION 'a finish alert closed on a receipt that paid a different winner';
  END IF;

  -- A second pass is a no-op.
  v := public.fn_resolve_settled_financial_alerts(true, 5000);
  IF (v->>'total')::int <> 0 THEN RAISE EXCEPTION 'second pass closed % more', v->>'total'; END IF;

  -- The payout lands later: the next pass closes that one alert only.
  UPDATE public.tournament_payouts SET paid_at = now() WHERE tournament_id = t_unpaid;
  v := public.fn_resolve_settled_financial_alerts(true, 5000);
  IF (v->>'finish_committed_after_alert')::int IS DISTINCT FROM 1
     OR NOT (SELECT resolved FROM public.financial_alerts WHERE context->>'case' = 'unpaid') THEN
    RAISE EXCEPTION 'a finish alert did not close once its last payout was paid: %', v;
  END IF;
END
$cases$;
SELECT 'finish-refusal-alert-closer-acceptance-passed';
