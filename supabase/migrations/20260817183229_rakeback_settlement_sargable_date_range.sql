-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260817183229 "rakeback_settlement_sargable_date_range"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7e1326ca05bec6dcaaf79645b28c75ad of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- fn_close_settlement_period: make the date filter sargable.
--
-- TIER 3 (money function body change). Behaviour-preserving.
--
-- WHY
-- ---
-- 2026-08-17, from the live engine log:
--   [RakebackSettler.fetch_failed] Error: canceling statement due to statement
--   timeout at RakebackSettlerService._runSettlementInner
--
-- The aggregation filtered with `r.created_at::date >= v_period.period_start`.
-- Casting the column kills sargability, so no created_at index can be used and
-- Postgres scanned the whole club partition. Measured for ONE user-period:
--
--   ::date cast          5140 ms   Rows Removed by Filter: 198,229
--   range form           2265 ms   (created_at index now usable)
--   + GIN + composite      96 ms   BitmapAnd, Heap Blocks: 869
--
-- 53x faster. Two indexes were added alongside this migration (both built
-- CONCURRENTLY, both confirmed used by the planner in a BitmapAnd):
--   idx_rake_records_contribs_gin   gin (player_contributions)  -- the ? operator
--   idx_rake_records_club_created   (club_id, created_at) WHERE rake_amount > 0
-- jsonb_ops is required, NOT jsonb_path_ops: only jsonb_ops indexes `?`.
--
-- EQUIVALENCE
-- -----------
-- period_start/period_end are DATE. `created_at::date BETWEEN start AND end`
-- selects exactly `created_at >= start::timestamptz AND created_at < (end+1)`,
-- because the cast truncates to midnight and the upper bound is exclusive of
-- the following midnight. Same rows, no boundary change. Everything else in
-- the function -- the equal-share denominator over every player dealt in
-- (DECISION D-001), tier rates, payout, wallet credit -- is untouched.
-- ============================================================================

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_close_settlement_period';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'PRE-FLIGHT: fn_close_settlement_period does not exist';
  END IF;
  IF v_def NOT LIKE '%created_at::date%' THEN
    RAISE EXCEPTION 'PRE-FLIGHT: expected the ::date cast in the live body; it is absent (already migrated?)';
  END IF;
  IF v_def NOT LIKE '%jsonb_object_keys(r.player_contributions)%' THEN
    RAISE EXCEPTION 'PRE-FLIGHT: dealt-in denominator missing - refusing to overwrite an unexpected body';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_close_settlement_period(p_period_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_period         record;
  v_rake_total     numeric;
  v_rate           numeric;
  v_payout         numeric;
  v_payout_id      uuid;
  v_wallet_balance numeric;
BEGIN
  SELECT * INTO v_period FROM public.rakeback_periods WHERE id = p_period_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'period not found');
  END IF;

  IF v_period.status IN ('paid', 'expired') THEN
    RETURN jsonb_build_object('success', true, 'skipped', v_period.status, 'period_id', p_period_id);
  END IF;

  -- EQUAL-SHARE across EVERY PLAYER DEALT IN (DECISION D-001).
  -- Denominator = number of keys in player_contributions (all dealt-in seats).
  -- Eligibility = the user's key is present; the contribution VALUE is
  -- deliberately not consulted -- contributing 0 chips does not make a player
  -- any less dealt in.
  --
  -- Date filter is a half-open RANGE, not a ::date cast, so created_at stays
  -- sargable and the (club_id, created_at) + GIN indexes can be combined.
  SELECT COALESCE(SUM(
           r.rake_amount / GREATEST(
             (SELECT count(*) FROM jsonb_object_keys(r.player_contributions) k), 1)
         ), 0)
    INTO v_rake_total
    FROM public.rake_records r
   WHERE r.club_id = v_period.club_id
     AND r.created_at >= v_period.period_start::timestamptz
     AND r.created_at <  (v_period.period_end + 1)::timestamptz
     AND r.rake_amount > 0
     AND r.player_contributions IS NOT NULL
     AND (r.player_contributions ? v_period.user_id::text);

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
    'payout', v_payout, 'payout_id', v_payout_id);
END;
$function$;

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_close_settlement_period';
  IF v_def LIKE '%created_at::date%' THEN
    RAISE EXCEPTION 'POST-APPLY: ::date cast still present';
  END IF;
  IF v_def NOT LIKE '%jsonb_object_keys(r.player_contributions)%' THEN
    RAISE EXCEPTION 'POST-APPLY: dealt-in denominator was lost';
  END IF;
  IF v_def NOT LIKE '%(v_period.period_end + 1)::timestamptz%' THEN
    RAISE EXCEPTION 'POST-APPLY: half-open upper bound missing';
  END IF;
  RAISE NOTICE 'OK: settlement window is sargable; dealt-in denominator intact';
END $$;
