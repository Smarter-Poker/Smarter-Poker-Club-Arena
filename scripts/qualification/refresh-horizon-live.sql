CREATE OR REPLACE FUNCTION public.fn_union_rake_basis_refresh(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_through timestamptz; v_t0 timestamptz := clock_timestamp(); v_detail jsonb; v_n int;
  v_accrued timestamptz; v_stamp jsonb; v_prev jsonb; v_win jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR NOT public.fn_is_platform_admin()) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;
  IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'bad_params');
  END IF;
  IF LEAST(p_end, now()) <= p_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'window_not_open_yet');
  END IF;

  -- Cash earning sources are written by the rakeback settler as its durable
  -- cursor advances; every bank receipt below the cursor has been accrued and
  -- none above it is claimed. Read through that instant, never through now().
  SELECT d.high_water_mark INTO v_accrued FROM public.daemon_state d WHERE d.daemon = 'rakeback_settler';
  IF v_accrued IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'accrual_cursor_unknown');
  END IF;
  v_through := LEAST(p_end, now(), v_accrued);
  IF v_through <= p_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'accrual_not_yet_in_window',
                              'accrued_through', v_accrued);
  END IF;

  -- WHAT THIS REFRESH WOULD READ (2026-09-26). Every table the plan reads its
  -- rows from is append-only, so the same through and the same counts in the
  -- window are the same rows, and the same rows are the same detail. An
  -- unchanged stamp is not recomputed; a moved cursor or a new row is.
  v_stamp := jsonb_build_object(
    'through', v_through,
    'bank', (SELECT jsonb_build_array(count(*), COALESCE(sum(t.amount), 0))
               FROM public.union_wallet_transactions t
              WHERE t.union_id = p_union_id AND t.wallet = 'rake_wallet' AND t.direction = 'credit'
                AND t.tx_type = 'rake' AND t.created_at >= p_start AND t.created_at < v_through),
    'cash_receipts', (SELECT count(*) FROM public.accounting_cash_bank_receipts c
                       WHERE c.union_id = p_union_id AND c.banked_at >= p_start AND c.banked_at < v_through),
    'recognitions', (SELECT count(*) FROM public.accounting_tournament_fee_recognitions f
                      WHERE f.union_id = p_union_id AND f.recognized_at >= p_start AND f.recognized_at < v_through),
    -- 20261003: sources are written with their accrual batch or their
    -- recognition; counting those replaces a whole-week read of the view.
    'batches', (SELECT count(*) FROM public.accounting_cash_accrual_batches b
                 WHERE b.earned_at >= p_start AND b.earned_at < v_through),
    'recognized', (SELECT count(*) FROM public.accounting_tournament_recognized_sources rs
                    WHERE rs.recognized_at >= p_start AND rs.recognized_at < v_through),
    'agreements', (SELECT jsonb_build_array(count(*), max(h.id)) FROM public.accounting_agreement_history h));

  SELECT s.input_stamp INTO v_prev FROM public.union_rake_basis_snapshot s
   WHERE s.union_id = p_union_id AND s.period_start = p_start AND s.period_end = p_end;
  IF v_prev IS NOT NULL AND v_prev = v_stamp THEN
    RETURN jsonb_build_object('success', true, 'skipped', true, 'reason', 'inputs_unchanged',
                              'union_id', p_union_id, 'period_start', p_start, 'period_end', p_end,
                              'through', v_through, 'accrued_through', v_accrued,
                              'check_ms', (extract(epoch from clock_timestamp() - v_t0) * 1000)::int);
  END IF;

  -- TWO HOURS AT A TIME (20261003): the same basis from proved two-hour
  -- windows, the closed ones kept while their inputs are unchanged.
  v_win := public.fn_union_rake_basis_windowed(p_union_id, p_start, v_through);
  IF v_win->>'status' = 'in_progress' THEN
    RETURN jsonb_build_object('success', true, 'skipped', true, 'reason', 'windows_in_progress',
                              'union_id', p_union_id, 'period_start', p_start, 'period_end', p_end,
                              'through', v_through, 'accrued_through', v_accrued, 'windows', v_win,
                              'check_ms', (extract(epoch from clock_timestamp() - v_t0) * 1000)::int);
  END IF;
  IF v_win->>'status' = 'ready' THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id', b.club_id, 'game_type', b.game_type,
                                               'rake_in', b.rake_in, 'rate', b.rate, 'payout', b.payout)
                            ORDER BY b.club_id, b.game_type), '[]'::jsonb), count(*)
    INTO v_detail, v_n
    FROM (SELECT (d->>'club_id')::uuid AS club_id, d->>'game_type' AS game_type, (d->>'rake_in')::numeric AS rake_in,
                 (d->>'rate')::numeric AS rate, (d->>'payout')::numeric AS payout
            FROM jsonb_array_elements(v_win->'basis_detail') d) b;
  ELSE
  SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id', b.club_id, 'game_type', b.game_type,
                                               'rake_in', b.rake_in, 'rate', b.rate, 'payout', b.payout)
                            ORDER BY b.club_id, b.game_type), '[]'::jsonb), count(*)
    INTO v_detail, v_n
    FROM public.fn_union_club_rake_basis(p_union_id, p_start, v_through, true) b;
  END IF;

  INSERT INTO public.union_rake_basis_snapshot (union_id, period_start, period_end, through, computed_at, compute_ms, detail, input_stamp)
  VALUES (p_union_id, p_start, p_end, v_through, now(),
          (extract(epoch from clock_timestamp() - v_t0) * 1000)::int, v_detail, v_stamp)
  ON CONFLICT (union_id, period_start, period_end) DO UPDATE
    SET through = EXCLUDED.through, computed_at = EXCLUDED.computed_at,
        compute_ms = EXCLUDED.compute_ms, detail = EXCLUDED.detail,
        input_stamp = EXCLUDED.input_stamp;

  RETURN jsonb_build_object('success', true, 'skipped', false, 'union_id', p_union_id, 'period_start', p_start,
                            'period_end', p_end, 'through', v_through, 'rows', v_n,
                            'accrued_through', v_accrued,
                            'compute_ms', (extract(epoch from clock_timestamp() - v_t0) * 1000)::int);
END;
$function$
;
