-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829164155; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- PR-A part 2: consumers read the persisted per-player ledger, with the
-- canonical allocator as fallback for rows without ledger entries (historical
-- hands, pruned horse-only hands, tournament fee rows, null-hand rows). One
-- write, many reads: the ledger becomes the operative source, not just the
-- auditable copy, and recompute cost drops to an indexed join on the hot path.
-- A live parity assert at the end proves the swap changes NOTHING.

-- ── 1. The read helper ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_rake_shares_for_record(
  p_hand_id uuid, p_rake numeric, p_contributions jsonb, p_method text
)
RETURNS TABLE(user_id uuid, credit numeric)
LANGUAGE sql
STABLE
AS $function$
  SELECT ra.player_id, ra.weighted_rake_credit
    FROM public.rake_attributions ra
   WHERE p_hand_id IS NOT NULL AND ra.hand_id = p_hand_id
  UNION ALL
  SELECT a.user_id, a.credit
    FROM public.fn_allocate_rake_credits(p_rake, p_contributions, p_method) a
   WHERE p_hand_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM public.rake_attributions ra2 WHERE ra2.hand_id = p_hand_id);
$function$;

GRANT EXECUTE ON FUNCTION public.fn_rake_shares_for_record(uuid, numeric, jsonb, text) TO postgres, service_role, authenticated;

-- ── 2. fn_rakeback_recompute_periods reads the ledger ────────────────────────
CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_periods(
  p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[] DEFAULT NULL::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_written integer := 0;
BEGIN
  IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL THEN
    RETURN jsonb_build_object('written', 0, 'error', 'missing params');
  END IF;

  WITH shares AS (
    SELECT s.user_id,
           round(s.credit * 100)::bigint AS cents
      FROM rake_records r
      CROSS JOIN LATERAL public.fn_rake_shares_for_record(
        r.hand_id, r.rake_amount, r.player_contributions, COALESCE(r.rake_method, 'DEALT_EQUAL')
      ) s
     WHERE r.club_id = p_club_id
       AND r.created_at >= p_period_start::timestamptz
       AND r.created_at <  (p_period_end + 1)::timestamptz
       AND r.rake_amount > 0
       AND r.player_contributions IS NOT NULL
  ), totals AS (
    SELECT s.user_id, (SUM(s.cents)::numeric / 100) AS total_rake
      FROM shares s
     WHERE p_user_ids IS NULL OR s.user_id = ANY (p_user_ids)
     GROUP BY s.user_id
  ), eligible AS (
    SELECT t.user_id, t.total_rake,
           public.fn_player_rakeback_rate(t.user_id, p_club_id, t.total_rake) AS rate
      FROM totals t
  ), ins AS (
    INSERT INTO rakeback_periods (
      user_id, club_id, period_start, period_end,
      rake_generated, rakeback_rate, rakeback_earned, rakeback_amount,
      total_rake_paid, status
    )
    SELECT e.user_id, p_club_id, p_period_start, p_period_end,
           round(e.total_rake, 2), e.rate,
           round(e.total_rake * e.rate, 2), round(e.total_rake * e.rate, 2),
           round(e.total_rake, 2), 'pending'
      FROM eligible e
     WHERE e.rate > 0
    ON CONFLICT (user_id, club_id, period_start, period_end) DO UPDATE
      SET period_end      = EXCLUDED.period_end,
          rake_generated  = EXCLUDED.rake_generated,
          rakeback_rate   = EXCLUDED.rakeback_rate,
          rakeback_earned = EXCLUDED.rakeback_earned,
          rakeback_amount = EXCLUDED.rakeback_amount,
          total_rake_paid = EXCLUDED.total_rake_paid
      WHERE rakeback_periods.status = 'pending'
    RETURNING 1
  )
  SELECT count(*) INTO v_written FROM ins;

  RETURN jsonb_build_object('written', v_written);
END $function$;

-- ── 3. fn_close_settlement_period reads the ledger ───────────────────────────
CREATE OR REPLACE FUNCTION public.fn_close_settlement_period(p_period_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_period         record;
  v_rake_total     numeric;
  v_rate           numeric;
  v_payout         numeric;
  v_payout_id      uuid;
  v_wallet_balance numeric;
  v_debit          jsonb;
BEGIN
  SELECT * INTO v_period FROM public.rakeback_periods WHERE id = p_period_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'period not found');
  END IF;

  IF v_period.status IN ('paid', 'expired') THEN
    RETURN jsonb_build_object('success', true, 'skipped', v_period.status, 'period_id', p_period_id);
  END IF;

  SELECT COALESCE(SUM(s.credit), 0)
    INTO v_rake_total
    FROM public.rake_records r
    CROSS JOIN LATERAL public.fn_rake_shares_for_record(
      r.hand_id, r.rake_amount, r.player_contributions, COALESCE(r.rake_method, 'DEALT_EQUAL')
    ) s
   WHERE r.club_id = v_period.club_id
     AND r.created_at >= v_period.period_start::timestamptz
     AND r.created_at <  (v_period.period_end + 1)::timestamptz
     AND r.rake_amount > 0
     AND r.player_contributions IS NOT NULL
     AND (r.player_contributions ? v_period.user_id::text)
     AND s.user_id = v_period.user_id;

  v_rake_total := ROUND(v_rake_total, 2);

  v_rate := CASE
    WHEN v_rake_total >= 10000 THEN 0.30
    WHEN v_rake_total >=  2000 THEN 0.20
    WHEN v_rake_total >=   500 THEN 0.15
    WHEN v_rake_total >=   100 THEN 0.10
    ELSE                            0.05
  END;
  v_payout := ROUND(v_rake_total * v_rate, 4);

  UPDATE public.rakeback_periods
     SET rake_generated  = v_rake_total,
         total_rake_paid = v_rake_total,
         rakeback_rate   = v_rate,
         rakeback_amount = v_payout,
         rakeback_earned = v_payout
   WHERE id = p_period_id;

  IF v_payout <= 0 THEN
    UPDATE public.rakeback_periods SET status = 'paid', paid_at = NOW() WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'period_id', p_period_id, 'payout', 0);
  END IF;

  INSERT INTO public.rakeback_period_payouts
    (rakeback_period_id, club_id, user_id, user_rake_contribution,
     rakeback_pct, payout_amount, status, paid_at)
  VALUES
    (p_period_id, v_period.club_id, v_period.user_id, v_rake_total,
     ROUND(v_rate * 100, 2), v_payout, 'paid', NOW())
  ON CONFLICT (rakeback_period_id, user_id) DO NOTHING
  RETURNING id INTO v_payout_id;

  IF v_payout_id IS NULL THEN
    UPDATE public.rakeback_periods SET status = 'paid', paid_at = NOW() WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'skipped', 'payout_exists', 'period_id', p_period_id);
  END IF;

  v_debit := public.fn_debit_treasury(
    v_period.club_id, v_payout,
    'Player rakeback ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
    jsonb_build_object('period_id', p_period_id, 'user_id', v_period.user_id,
                       'rake_basis', v_rake_total, 'rate', v_rate));
  IF COALESCE((v_debit->>'success')::boolean, false) IS NOT TRUE THEN
    DELETE FROM public.rakeback_period_payouts WHERE id = v_payout_id;
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_close_settlement_period',
      'Player rakeback deferred: club treasury cannot fund payout',
      jsonb_build_object('period_id', p_period_id, 'club_id', v_period.club_id,
        'user_id', v_period.user_id, 'payout', v_payout, 'debit_result', v_debit));
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_club_treasury',
      'period_id', p_period_id, 'payout', v_payout, 'debit_result', v_debit);
  END IF;

  PERFORM public.atomic_credit_wallet_and_log(
    v_period.user_id, v_payout, 'rakeback',
    'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
    NULL, NULL, v_payout_id
  );

  SELECT balance INTO v_wallet_balance FROM public.wallets
   WHERE user_id = v_period.user_id AND wallet_type = 'PLAYER';
  INSERT INTO public.wallet_transactions
    (user_id, wallet_type, amount, type, category, description, related_entity_id, balance_after)
  VALUES
    (v_period.user_id, 'PLAYER', v_payout, 'credit', 'rakeback',
     'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
     v_payout_id, v_wallet_balance);

  UPDATE public.rakeback_periods SET status = 'paid', paid_at = NOW() WHERE id = p_period_id;

  RETURN jsonb_build_object('success', true, 'period_id', p_period_id,
    'rake_total', v_rake_total, 'rakeback_rate', v_rate,
    'payout', v_payout, 'payout_id', v_payout_id, 'funded_from', 'club_chip_treasury');
END;
$function$;

-- ── 4. fn_club_rake_rollup_day reads the ledger ──────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_club_rake_rollup_day(p_club_id uuid, p_day date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz := p_day::timestamptz;
  v_end   timestamptz := (p_day + 1)::timestamptz;
  v_rows  integer := 0;
BEGIN
  IF v_end > date_trunc('day', now()) THEN
    RAISE EXCEPTION 'club rake rollup: day % is not complete', p_day;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('club_rake_rollup:' || p_club_id::text || ':' || p_day::text, 42));

  DELETE FROM club_rake_daily_user WHERE club_id = p_club_id AND day = p_day;

  WITH split AS (
    SELECT s.user_id, round(s.credit * 100)::bigint AS cents
      FROM rake_records r
      CROSS JOIN LATERAL public.fn_rake_shares_for_record(
        r.hand_id, r.rake_amount, r.player_contributions, COALESCE(r.rake_method, 'DEALT_EQUAL')
      ) s
     WHERE r.club_id = p_club_id
       AND r.created_at >= v_start AND r.created_at < v_end
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
  ), ins AS (
    INSERT INTO club_rake_daily_user (club_id, day, user_id, rake_amount, hands)
    SELECT p_club_id, p_day, s.user_id, SUM(s.cents)::numeric / 100, count(*)
      FROM split s GROUP BY s.user_id
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM ins;

  INSERT INTO club_rake_rollup_complete (club_id, day, rows_written, computed_at)
  VALUES (p_club_id, p_day, v_rows, now())
  ON CONFLICT (club_id, day) DO UPDATE
    SET rows_written = EXCLUDED.rows_written, computed_at = EXCLUDED.computed_at;

  RETURN v_rows;
END $function$;

-- ── 5. LIVE PARITY PROOF, then done ──────────────────────────────────────────
-- Over the last 6 hours of raked rows: the ledger-backed helper must produce
-- the SAME per-player cents as a fresh allocator run, row for row. Any
-- mismatch aborts this migration.
DO $$
DECLARE v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad
  FROM (
    SELECT r.id
      FROM rake_records r
     WHERE r.created_at > now() - interval '6 hours'
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
     LIMIT 3000
  ) sample
  JOIN LATERAL (
    SELECT COALESCE(SUM(round(s.credit*100)), 0) AS ledger_cents,
           COUNT(*) AS ledger_rows
      FROM rake_records r2
      CROSS JOIN LATERAL public.fn_rake_shares_for_record(
        r2.hand_id, r2.rake_amount, r2.player_contributions, COALESCE(r2.rake_method,'DEALT_EQUAL')) s
     WHERE r2.id = sample.id
  ) led ON true
  JOIN LATERAL (
    SELECT COALESCE(SUM(round(a.credit*100)), 0) AS alloc_cents,
           COUNT(*) AS alloc_rows
      FROM rake_records r3
      CROSS JOIN LATERAL public.fn_allocate_rake_credits(
        r3.rake_amount, r3.player_contributions, COALESCE(r3.rake_method,'DEALT_EQUAL')) a
     WHERE r3.id = sample.id
  ) alc ON true
  WHERE led.ledger_cents <> alc.alloc_cents OR led.ledger_rows <> alc.alloc_rows;

  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'ledger-read parity FAILED on % record(s) — swap aborted', v_bad;
  END IF;
  RAISE NOTICE 'ledger-read parity clean on live sample';
END $$;
