  -- G. Legacy-fallback alarm (phase 2b): once the engine settles ≥50% of
  -- hands through the atomic claim RPC (24h view), any last-hour coverage
  -- below 90% means a regression re-opened the unsafe per-seat path.
  DECLARE
    v_hands_24h bigint; v_claims_24h bigint; v_hands_1h bigint; v_claims_1h bigint;
  BEGIN
    SELECT count(*) INTO v_hands_24h FROM public.hand_history
     WHERE created_at > now() - interval '24 hours' AND has_human;
    SELECT count(*) INTO v_claims_24h FROM public.settlement_idempotency_keys
     WHERE first_attempt_at > now() - interval '24 hours';
    IF v_hands_24h > 100 AND v_claims_24h >= v_hands_24h / 2 THEN
      SELECT count(*) INTO v_hands_1h FROM public.hand_history
       WHERE created_at > now() - interval '60 minutes' AND has_human;
      SELECT count(*) INTO v_claims_1h FROM public.settlement_idempotency_keys
       WHERE first_attempt_at > now() - interval '60 minutes';
      IF v_hands_1h >= 20 AND v_claims_1h < (v_hands_1h * 9) / 10 THEN
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_settlement_correctness_check:fallback_regression', 'settlement_error', 'warning',
          'fallback-regression:' || to_char(now(), 'YYYY-MM-DD-HH24'),
          0, v_hands_1h, v_claims_1h, 'settlement', 'settlement_idempotency_keys',
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          'atomic hand settlement coverage fell to ' || v_claims_1h || '/' || v_hands_1h
            || ' hands in the last hour after adoption - the engine has regressed to the legacy per-seat write path',
          NULL, jsonb_build_object('claims_1h', v_claims_1h, 'hands_1h', v_hands_1h));
        n := n + 1;
      END IF;
    END IF;
  END;

