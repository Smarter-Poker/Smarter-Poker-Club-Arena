-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 23:40:52 UTC on kuklfnapbkmacvwxktbh.

-- ZERO-DRIFT PHASE 3B: fn_union_weekly_rakeback_close walks the
-- ca_settlements state machine with a guarded money section. Any mid-flight
-- failure rolls every movement back, marks the settlement failed (retryable)
-- and raises a critical incident. Payouts journal as category 'rakeback'.
CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close(
  p_union_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wallet       public.union_wallets%ROWTYPE;
  v_period_total numeric := 0;
  v_payout_total numeric := 0;
  v_retained     numeric := 0;
  v_clubs_paid   integer := 0;
  v_club         record;
  v_rw_debit     numeric;
  v_new_rw       numeric;
  v_new_cb       numeric;
  v_credit       jsonb;
  v_sref         text;
  v_sid          uuid;
  v_sstate       text;
BEGIN
  -- EMERGENCY SETTLEMENT LOCK CHECK
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_end <= p_period_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'bad_params');
  END IF;

  IF EXISTS (
    SELECT 1 FROM union_rakeback_log
     WHERE union_id = p_union_id
       AND period_start = p_period_start AND period_end = p_period_end
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_executed');
  END IF;

  -- settlement walk: one row per (union, period), resumable after 'failed'
  v_sref := p_union_id::text || ':'
    || to_char(p_period_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
    || to_char(p_period_end   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  SELECT id, state INTO v_sid, v_sstate
    FROM ca_settlements
   WHERE settlement_type = 'union_rakeback_close' AND external_ref = v_sref
   FOR UPDATE;
  IF v_sid IS NULL THEN
    INSERT INTO ca_settlements (id, settlement_type, external_ref, state, union_id, totals)
    VALUES (gen_random_uuid(), 'union_rakeback_close', v_sref, 'open', p_union_id, '{}'::jsonb)
    RETURNING id INTO v_sid;
  ELSIF v_sstate = 'final' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_executed', 'settlement_id', v_sid);
  ELSIF v_sstate = 'failed' THEN
    UPDATE ca_settlements SET state = 'open', error_detail = NULL WHERE id = v_sid;  -- resume
  ELSE
    -- intermediate states never persist (single transaction), so anything
    -- else here is a concurrent close of the same period. Refuse loudly.
    RETURN jsonb_build_object('success', false, 'error', 'close_already_in_state_' || v_sstate,
                              'settlement_id', v_sid);
  END IF;

  UPDATE ca_settlements SET state = 'locked_for_calculation' WHERE id = v_sid;

  SELECT * INTO v_wallet FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF v_wallet.union_id IS NULL THEN
    UPDATE ca_settlements SET state = 'failed', error_detail = 'no_wallet' WHERE id = v_sid;
    RETURN jsonb_build_object('success', false, 'error', 'no_wallet', 'settlement_id', v_sid);
  END IF;

  DROP TABLE IF EXISTS _uwrb;
  CREATE TEMP TABLE _uwrb ON COMMIT DROP AS
  SELECT t.club_id,
         SUM(t.amount) AS rake_in,
         trunc(SUM(t.amount) * COALESCE(uc.club_commission_rate, 0.90) * 100) / 100 AS payout
    FROM union_wallet_transactions t
    LEFT JOIN union_clubs uc
           ON uc.union_id = t.union_id AND uc.club_id = t.club_id
   WHERE t.union_id = p_union_id
     AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
     AND t.created_at >= p_period_start AND t.created_at < p_period_end
   GROUP BY t.club_id, uc.club_commission_rate;

  SELECT COALESCE(SUM(rake_in), 0) INTO v_period_total FROM _uwrb;
  SELECT COALESCE(SUM(payout), 0) INTO v_payout_total
    FROM _uwrb WHERE club_id IS NOT NULL AND club_id <> p_union_id;

  UPDATE ca_settlements
     SET state = 'calculated',
         totals = jsonb_build_object('period_rake', v_period_total, 'payout_total', v_payout_total)
   WHERE id = v_sid;

  IF v_period_total <= 0 THEN
    INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
    VALUES (p_union_id, p_period_start, p_period_end, 0, now());
    UPDATE ca_settlements SET state = 'validated' WHERE id = v_sid;
    UPDATE ca_settlements SET state = 'ledger_posted' WHERE id = v_sid;
    UPDATE ca_settlements SET state = 'post_commit_verified' WHERE id = v_sid;
    UPDATE ca_settlements SET state = 'final' WHERE id = v_sid;
    RETURN jsonb_build_object('success', true, 'clubs_paid', 0,
      'period_rake', 0, 'total_rakeback', 0, 'union_retained', 0, 'note', 'no_rake',
      'settlement_id', v_sid);
  END IF;

  IF v_payout_total > COALESCE(v_wallet.chip_balance, 0)
     OR v_payout_total > COALESCE(v_wallet.rake_wallet, 0) THEN
    UPDATE ca_settlements SET state = 'failed', error_detail = 'insufficient_treasury' WHERE id = v_sid;
    PERFORM public.fn_ca_raise_drift_incident(
      'rakeback_close', 'incorrect_rakeback', 'critical',
      'rakeback-insufficient:' || p_union_id::text || ':' || to_char(p_period_start, 'YYYY-MM-DD'),
      v_payout_total - LEAST(COALESCE(v_wallet.chip_balance, 0), COALESCE(v_wallet.rake_wallet, 0)),
      v_payout_total,
      LEAST(COALESCE(v_wallet.chip_balance, 0), COALESCE(v_wallet.rake_wallet, 0)),
      'union_wallet', 'union', p_union_id, NULL, p_union_id,
      NULL, NULL, NULL, v_sid::text, NULL, NULL,
      'union wallet cannot cover the weekly rakeback payout; close refused before any movement',
      true,
      jsonb_build_object('rake_wallet', v_wallet.rake_wallet,
                         'chip_balance', v_wallet.chip_balance,
                         'payout', v_payout_total,
                         'period_start', p_period_start, 'period_end', p_period_end));
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_treasury', 'retryable', true,
      'payout', v_payout_total,
      'rake_wallet', v_wallet.rake_wallet, 'chip_balance', v_wallet.chip_balance,
      'settlement_id', v_sid);
  END IF;

  UPDATE ca_settlements SET state = 'validated' WHERE id = v_sid;

  -- ── guarded money section: all of it lands, or none of it does ────────────
  BEGIN
    PERFORM set_config('app.ledger_category', 'rakeback', true);
    PERFORM set_config('app.ledger_counterparty', 'union_wallet', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_union_id::text, true);
    PERFORM set_config('app.ledger_settlement', v_sid::text, true);
    /* the union-side debit is already recorded in union_wallet_transactions;
       a second auto-journal row would double-post the flow */
    PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);

    FOR v_club IN
      SELECT club_id, rake_in, payout FROM _uwrb
       WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0
    LOOP
      v_credit := fn_credit_treasury(
        v_club.club_id, v_club.payout,
        'Union weekly rakeback ' || to_char(p_period_start, 'YYYY-MM-DD')
          || '..' || to_char(p_period_end, 'YYYY-MM-DD'),
        jsonb_build_object('union_id', p_union_id,
                           'period_start', p_period_start, 'period_end', p_period_end,
                           'rake_basis', v_club.rake_in, 'rate', 'club_commission_rate',
                           'settlement_id', v_sid)
      );
      IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'treasury credit failed for club %: %', v_club.club_id, v_credit;
      END IF;
      v_clubs_paid := v_clubs_paid + 1;
    END LOOP;

    v_retained := v_period_total - v_payout_total;
    v_rw_debit := LEAST(v_period_total, COALESCE(v_wallet.rake_wallet, 0));

    UPDATE union_wallets
       SET rake_wallet       = rake_wallet - v_rw_debit,
           chip_balance      = chip_balance - v_payout_total,
           total_settlements = COALESCE(total_settlements, 0) + v_payout_total,
           updated_at        = now()
     WHERE union_id = p_union_id
     RETURNING rake_wallet, chip_balance INTO v_new_rw, v_new_cb;

    INSERT INTO union_wallet_transactions
      (union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes)
    SELECT p_union_id, club_id, payout, 'rakeback', 'rake_wallet', 'debit', v_new_rw,
           'Weekly 90% rakeback to club (period '
             || to_char(p_period_start, 'YYYY-MM-DD') || '..'
             || to_char(p_period_end, 'YYYY-MM-DD') || ')'
      FROM _uwrb
     WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0;

    IF v_retained > 0 THEN
      INSERT INTO union_wallet_transactions
        (union_id, amount, tx_type, wallet, direction, balance_after, notes)
      VALUES
        (p_union_id, v_retained, 'rake_hold', 'chip_balance', 'credit', v_new_cb,
         'Union 10% retained + self-club rake, redesignated from rake_wallet to general funds (period '
           || to_char(p_period_start, 'YYYY-MM-DD') || '..'
           || to_char(p_period_end, 'YYYY-MM-DD') || ') - informational; chip_balance total unchanged by retention');
    END IF;

    UPDATE ca_settlements
       SET state = 'ledger_posted',
           totals = totals || jsonb_build_object('clubs_paid', v_clubs_paid,
                                                 'retained', v_retained,
                                                 'rw_debit', v_rw_debit)
     WHERE id = v_sid;

    INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
    VALUES (p_union_id, p_period_start, p_period_end, v_payout_total, now());

  EXCEPTION WHEN OTHERS THEN
    -- every money movement above just rolled back to the section start
    UPDATE ca_settlements
       SET state = 'failed', error_detail = left(SQLERRM, 2000)
     WHERE id = v_sid;
    PERFORM public.fn_ca_raise_drift_incident(
      'rakeback_close', 'incorrect_rakeback', 'critical',
      'rakeback-close-failed:' || p_union_id::text || ':' || to_char(p_period_start, 'YYYY-MM-DD'),
      0, NULL, NULL,
      'union_wallet', 'union', p_union_id, NULL, p_union_id,
      NULL, NULL, NULL, v_sid::text, NULL, NULL,
      left('weekly rakeback close aborted mid-flight and rolled back cleanly: ' || SQLERRM, 500),
      true,
      jsonb_build_object('sqlstate', SQLSTATE,
                         'period_start', p_period_start, 'period_end', p_period_end,
                         'clubs_paid_before_abort', v_clubs_paid));
    RETURN jsonb_build_object('success', false, 'error', 'close_failed', 'retryable', true,
      'detail', SQLERRM, 'settlement_id', v_sid);
  END;

  UPDATE ca_settlements SET state = 'post_commit_verified' WHERE id = v_sid;
  UPDATE ca_settlements SET state = 'final' WHERE id = v_sid;

  RETURN jsonb_build_object('success', true,
    'clubs_paid', v_clubs_paid,
    'period_rake', v_period_total,
    'total_rakeback', v_payout_total,
    'union_retained', v_retained,
    'rake_wallet_after', v_new_rw,
    'chip_balance_after', v_new_cb,
    'settlement_id', v_sid);
END $function$;

REVOKE ALL ON FUNCTION public.fn_union_weekly_rakeback_close(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_weekly_rakeback_close(uuid, timestamptz, timestamptz) TO service_role;;
