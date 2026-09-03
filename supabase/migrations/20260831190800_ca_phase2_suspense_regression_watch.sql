-- ZERO-DRIFT phase 2: with the suspense flow drained (top producers now
-- declare categories), NEW suspense flow is a regression signal, not a
-- category-migration metric. Standing 15-minute check: any hour with more
-- than 10 unclassified rows or more than 50 chips of unclassified movement
-- raises a WARNING incident (deduped hourly). The daily info rollup in
-- fn_ca_quick_reconcile stays as the dashboard metric.
-- (Prod note: the guard-inventory function row initially used
-- (object_a='public', object_b=fn) and was corrected in place to the
-- (object_a=fn) convention; this mirror carries the corrected form.)
CREATE OR REPLACE FUNCTION public.fn_ca_suspense_regression_check()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_rows integer; v_chips numeric;
BEGIN
  SELECT count(*), COALESCE(sum(amount), 0) INTO v_rows, v_chips
  FROM public.chip_ledger
  WHERE (from_type = 'settlement_suspense' OR to_type = 'settlement_suspense')
    AND created_at > now() - interval '60 minutes'
    -- the suspense drain went live 2026-08-31 19:01 UTC; never alarm on older flow
    AND created_at > '2026-08-31 19:01:00+00';

  IF v_rows > 10 OR v_chips > 50 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_suspense_regression_check', 'unauthorized_adjustment', 'warning',
      'suspense-regression:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      round(v_chips, 2), NULL, NULL, 'ledger', 'settlement_suspense',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'unclassified (suspense) flow returned after the phase-2 drain: '
        || v_rows || ' rows / ' || round(v_chips, 2) || ' chips in the last hour'
        || ' — a money path lost (or never had) its category declaration',
      false, jsonb_build_object('rows_last_hour', v_rows, 'chips_last_hour', round(v_chips, 2)));
    RETURN 1;
  END IF;
  RETURN 0;
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_suspense_regression_check() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('ca-suspense-regression-15m', '*/15 * * * *',
  $$SELECT public.fn_ca_suspense_regression_check();$$);

-- Register both under guard-integrity protection (function entries use
-- object_a = function name, cron entries use object_a = job name).
INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note, active)
VALUES
  ('function', 'fn_ca_suspense_regression_check', NULL, 'phase 2: suspense regression watchdog', true),
  ('cron', 'ca-suspense-regression-15m', NULL, 'phase 2: suspense regression check every 15 min', true)
ON CONFLICT DO NOTHING;

INSERT INTO public.ca_money_rpc_registry (proname, notes)
VALUES ('fn_ca_suspense_regression_check', 'phase 2 watchdog, read-only over chip_ledger')
ON CONFLICT DO NOTHING;
