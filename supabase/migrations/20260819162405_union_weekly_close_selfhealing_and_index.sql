-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819162405 "union_weekly_close_selfhealing_and_index"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8182418c94ceb0bd1403008ffa673a69 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- LINE-BY-LINE AUDIT 2026-08-19 (rake/BBJ pass 2), DEFECT #7 + #8:
--
-- #7 The engine's weekly close only attempted the SINGLE most recent lapsed
--    week, and its daemon watermark advanced even when the union-close step
--    failed — an engine outage spanning a Monday (or one transient failure)
--    left that week's rakeback permanently unexecuted. New
--    fn_union_weekly_rakeback_close_all closes EVERY unclosed lapsed ISO week
--    from the last executed period (or first treasury credit) to now —
--    self-healing regardless of downtime length. Also: a temp-table guard so
--    repeated calls in one session/txn cannot collide, and a durable
--    financial_alerts row when a close is rejected for insufficient treasury.
--
-- #8 union_wallet_transactions had no index serving the weekly-close basis scan
--    (union_id + wallet/type/direction + created_at range over a ~500k-row
--    week in a multi-million-row table). Partial index added.

CREATE INDEX IF NOT EXISTS idx_uwt_rake_credit_basis
  ON public.union_wallet_transactions (union_id, created_at)
  WHERE wallet = 'rake_wallet' AND direction = 'credit' AND tx_type = 'rake';

CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close(
  p_union_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
BEGIN
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

  SELECT * INTO v_wallet FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF v_wallet.union_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_wallet');
  END IF;

  -- Guard: this fn can run several times in one session (close_all loop).
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

  IF v_period_total <= 0 THEN
    INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
    VALUES (p_union_id, p_period_start, p_period_end, 0, now());
    RETURN jsonb_build_object('success', true, 'clubs_paid', 0,
      'period_rake', 0, 'total_rakeback', 0, 'union_retained', 0, 'note', 'no_rake');
  END IF;

  IF v_payout_total > COALESCE(v_wallet.chip_balance, 0)
     OR v_payout_total > COALESCE(v_wallet.rake_wallet, 0) THEN
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('critical', 'fn_union_weekly_rakeback_close',
      'Weekly union rakeback REJECTED: payout exceeds treasury — investigate before forcing',
      jsonb_build_object('union_id', p_union_id,
        'period_start', p_period_start, 'period_end', p_period_end,
        'payout', v_payout_total,
        'rake_wallet', v_wallet.rake_wallet, 'chip_balance', v_wallet.chip_balance));
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_treasury',
      'payout', v_payout_total,
      'rake_wallet', v_wallet.rake_wallet, 'chip_balance', v_wallet.chip_balance);
  END IF;

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
                         'rake_basis', v_club.rake_in, 'rate', 'club_commission_rate')
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
         || to_char(p_period_end, 'YYYY-MM-DD') || ') — informational; chip_balance total unchanged by retention');
  END IF;

  INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
  VALUES (p_union_id, p_period_start, p_period_end, v_payout_total, now());

  RETURN jsonb_build_object('success', true,
    'clubs_paid', v_clubs_paid,
    'period_rake', v_period_total,
    'total_rakeback', v_payout_total,
    'union_retained', v_retained,
    'rake_wallet_after', v_new_rw,
    'chip_balance_after', v_new_cb);
END $$;

-- Self-healing driver: closes every unclosed lapsed ISO week for one union
-- (or all unions when called with no argument).
CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close_all(
  p_union_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_union        record;
  v_cursor       timestamptz;
  v_current_week timestamptz := date_trunc('week', now());
  v_result       jsonb;
  v_results      jsonb := '[]'::jsonb;
  v_guard        integer;
BEGIN
  FOR v_union IN
    SELECT id FROM unions WHERE p_union_id IS NULL OR id = p_union_id
  LOOP
    -- Resume from the newest executed period; else from the first treasury credit.
    SELECT MAX(period_end) INTO v_cursor
      FROM union_rakeback_log WHERE union_id = v_union.id;
    IF v_cursor IS NULL THEN
      SELECT MIN(created_at) INTO v_cursor
        FROM union_wallet_transactions
       WHERE union_id = v_union.id
         AND wallet = 'rake_wallet' AND direction = 'credit' AND tx_type = 'rake';
    END IF;
    IF v_cursor IS NULL THEN CONTINUE; END IF;

    v_cursor := date_trunc('week', v_cursor);
    v_guard := 0;
    WHILE v_cursor + interval '7 days' <= v_current_week AND v_guard < 60 LOOP
      v_result := fn_union_weekly_rakeback_close(
        v_union.id, v_cursor, v_cursor + interval '7 days');
      IF COALESCE(v_result->>'error', '') NOT IN ('', 'already_executed') THEN
        -- Rejected (e.g. insufficient treasury): stop advancing this union so
        -- the same week is retried next run; the close already alerted.
        v_results := v_results || jsonb_build_object(
          'union_id', v_union.id, 'period_start', v_cursor, 'result', v_result);
        EXIT;
      END IF;
      IF (v_result->>'success')::boolean IS TRUE THEN
        v_results := v_results || jsonb_build_object(
          'union_id', v_union.id, 'period_start', v_cursor, 'result', v_result);
      END IF;
      v_cursor := v_cursor + interval '7 days';
      v_guard := v_guard + 1;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'closes', v_results);
END $$;

REVOKE ALL ON FUNCTION public.fn_union_weekly_rakeback_close_all(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_weekly_rakeback_close_all(uuid) TO service_role;
