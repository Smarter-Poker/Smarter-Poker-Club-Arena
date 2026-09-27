  -- G. All-player atomic coverage: both windows count the same hand identities.
  -- The common commit receipt covers ordinary and diamond hands. The existing
  -- claims metadata keys remain compatible, and now mean matched receipts.
  DECLARE
    v_hands_24h bigint; v_claims_24h bigint; v_hands_1h bigint; v_claims_1h bigint;
  BEGIN
    WITH recent AS MATERIALIZED (
      SELECT id,table_id,hand_number,created_at
      FROM public.hand_history WHERE created_at>now()-interval '24 hours'
    ), receipts AS MATERIALIZED (
      SELECT hand_id,table_id,hand_number FROM public.hand_atomic_commits
      WHERE hand_number BETWEEN (SELECT min(hand_number) FROM recent)
                            AND (SELECT max(hand_number) FROM recent)
    )
    SELECT count(*) AS hands_24h,count(c.hand_id) AS commits_24h,
           count(*) FILTER(WHERE h.created_at>now()-interval '60 minutes') AS hands_1h,
           count(c.hand_id) FILTER(WHERE h.created_at>now()-interval '60 minutes') AS commits_1h
    INTO v_hands_24h,v_claims_24h,v_hands_1h,v_claims_1h
    FROM recent h LEFT JOIN receipts c
     ON c.hand_id=h.id AND c.table_id=h.table_id AND c.hand_number=h.hand_number
;
    IF v_hands_24h > 100 AND v_claims_24h >= v_hands_24h / 2 THEN
      IF v_hands_1h >= 20 AND v_claims_1h < (v_hands_1h * 9) / 10 THEN
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_settlement_correctness_check:fallback_regression', 'settlement_error', 'warning',
          'fallback-regression:' || to_char(now(), 'YYYY-MM-DD-HH24'),
          0, v_hands_1h, v_claims_1h, 'settlement', 'hand_atomic_commits',
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          'atomic hand settlement coverage fell to ' || v_claims_1h || '/' || v_hands_1h
            || ' hands in the last hour after adoption - matching atomic hand receipts are missing',
          NULL, jsonb_build_object('claims_1h', v_claims_1h, 'hands_1h', v_hands_1h));
        n := n + 1;
      END IF;
    END IF;
  END;

