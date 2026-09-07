-- A PERIOD THAT CANNOT PAY REFUSES BEFORE IT DOES THE WORK
-- =============================================================================
-- PHASE 5 of 8, part 3 - a correction to part 1, caught by its own probe.
--
-- The first behavioural probe of the new payer passed every assertion and then
-- reported this, which is the more useful result:
--
--   midway = { periods_settled: 0, deferred: 1,
--              deferred_reasons: { no_membership_at_earning_club: 1 },
--              elapsed_seconds: 8.045, clock_ran_out: true }
--
-- ONE period. Eight seconds. A budget of five. The batch overshot its budget by
-- 60% on a single period it was never going to pay, because I put the cheap
-- refusals in the wrong order: fn_close_settlement_period computed the rake
-- basis - the expensive thing, a full rake_records scan where the rollup does
-- not reach - and only then asked whether the player is a member of the club,
-- which is one indexed row.
--
-- That is not a slow path, it is a timeout. Midway has 792 periods with no
-- membership at the earning club. At ~8s each, a batch would be cancelled by
-- the 8s service_role statement_timeout on its FIRST period, for ever, and the
-- drain I just built would have failed exactly the way the one it replaced
-- did. The budget check only runs BETWEEN periods, so it cannot save a caller
-- from one period that overshoots on its own.
--
-- THE ORDER NOW: freeze, then membership, then the basis. Refuse in one indexed
-- lookup, or do the work.
--
-- AND THE CLUB IS ASKED FIRST. Midway owes 280,142.57 against a treasury of
-- 0.66. Every one of its 1,769 periods would compute a basis and then be
-- refused by fn_debit_treasury. The batch now reads the treasury once, and a
-- club that cannot fund even its smallest pending payout is deferred whole,
-- with its shortfall recorded, without touching a period. A backlog nobody can
-- pay should cost nothing to skip.
--
-- The default budget drops 5.0 -> 4.0 as well, so that even a genuinely slow
-- close - the ~2.6s rollup-missing fallback - lands at ~6.6s worst case rather
-- than 7.6s, inside the 8s ceiling with room that does not depend on the
-- database being unloaded.
-- =============================================================================

BEGIN;

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
  v_days_needed    int;
  v_days_have      int;
  v_from_rollup    boolean := true;
  v_is_member      boolean;
  v_balance        numeric;
  v_debit          jsonb;
BEGIN
  SELECT * INTO v_period FROM public.rakeback_periods WHERE id = p_period_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'period not found');
  END IF;

  IF v_period.status IN ('paid', 'expired') THEN
    RETURN jsonb_build_object('success', true, 'skipped', v_period.status, 'period_id', p_period_id);
  END IF;

  -- ---- EVERY CHEAP REFUSAL FIRST -------------------------------------------
  -- Each of these is one indexed lookup. The basis below is a rollup sum at
  -- best and a full rake_records scan at worst, and there is no reason to pay
  -- for it on a period that cannot be paid out either way.

  -- CLAUDE.md 13 rule 5: a sweep that moves money checks the freeze first.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('success', false, 'deferred', 'platform_frozen',
                              'period_id', p_period_id);
  END IF;

  -- Rakeback is earned at a club and belongs in that club's wallet. A player
  -- with no membership there is not quietly paid somewhere else, and is not
  -- worth a rake scan to discover that.
  SELECT EXISTS (SELECT 1 FROM public.club_members cm
                  WHERE cm.user_id = v_period.user_id
                    AND cm.club_id = v_period.club_id
                    AND cm.status IN ('active','approved'))
    INTO v_is_member;

  IF NOT v_is_member THEN
    UPDATE public.rakeback_periods
       SET deferred_reason = 'no_membership_at_earning_club',
           deferred_at = NOW(), defer_count = defer_count + 1
     WHERE id = p_period_id;
    RETURN jsonb_build_object('success', false, 'deferred', 'no_membership_at_earning_club',
      'period_id', p_period_id, 'club_id', v_period.club_id, 'user_id', v_period.user_id);
  END IF;

  -- ---- NOW THE WORK ---------------------------------------------------------
  -- rakeback_daily_user is the same allocation the writer used, computed once
  -- per club-day for every player. Where it does not cover the period - it
  -- began 2026-08-31 and the backlog reaches to 2026-07-20 - fall back to the
  -- original scan rather than pay somebody zero because a cache is cold.
  v_days_needed := (v_period.period_end - v_period.period_start) + 1;
  SELECT count(*) INTO v_days_have FROM public.rakeback_daily_state s
   WHERE s.club_id = v_period.club_id
     AND s.day BETWEEN v_period.period_start AND v_period.period_end;

  IF v_days_have >= v_days_needed THEN
    SELECT ROUND(COALESCE(SUM(d.cents), 0)::numeric / 100, 2)
      INTO v_rake_total
      FROM public.rakeback_daily_user d
     WHERE d.club_id = v_period.club_id
       AND d.user_id = v_period.user_id
       AND d.day BETWEEN v_period.period_start AND v_period.period_end;
  ELSE
    v_from_rollup := false;
    SELECT ROUND(COALESCE(SUM(s.credit), 0), 2)
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
  END IF;

  -- One source of truth for the rate: the player's own deal, else their agent's
  -- standing offer, else the legacy volume ladder, never more than the upline
  -- earns less ten points.
  v_rate   := public.fn_player_rakeback_rate(v_period.user_id, v_period.club_id, v_rake_total);
  v_payout := ROUND(v_rake_total * v_rate, 2);

  UPDATE public.rakeback_periods
     SET rake_generated  = v_rake_total,
         total_rake_paid = v_rake_total,
         rakeback_rate   = v_rate,
         rakeback_amount = v_payout,
         rakeback_earned = v_payout
   WHERE id = p_period_id;

  IF v_payout <= 0 THEN
    UPDATE public.rakeback_periods
       SET status = 'paid', paid_at = NOW(), deferred_reason = NULL, deferred_at = NULL
     WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'period_id', p_period_id, 'payout', 0,
                              'rake_total', v_rake_total, 'rakeback_rate', v_rate,
                              'from_rollup', v_from_rollup);
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
    UPDATE public.rakeback_periods
       SET status = 'paid', paid_at = NOW(), deferred_reason = NULL, deferred_at = NULL
     WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'skipped', 'payout_exists', 'period_id', p_period_id);
  END IF;

  v_debit := public.fn_debit_treasury(
    v_period.club_id, v_payout,
    'Player rakeback ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
    jsonb_build_object('period_id', p_period_id, 'user_id', v_period.user_id,
                       'rake_basis', v_rake_total, 'rate', v_rate));

  IF COALESCE((v_debit->>'success')::boolean, false) IS NOT TRUE THEN
    DELETE FROM public.rakeback_period_payouts WHERE id = v_payout_id;
    UPDATE public.rakeback_periods
       SET deferred_reason = 'insufficient_club_treasury',
           deferred_at = NOW(), defer_count = defer_count + 1
     WHERE id = p_period_id;
    RETURN jsonb_build_object('success', false, 'deferred', 'insufficient_club_treasury',
      'period_id', p_period_id, 'club_id', v_period.club_id, 'payout', v_payout,
      'treasury', v_debit->'balance');
  END IF;

  PERFORM set_config('app.ledger_club_id', v_period.club_id::text, true);

  PERFORM public.atomic_credit_wallet_and_log(
    v_period.user_id, v_payout, 'rakeback',
    'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
    NULL, NULL, v_payout_id, 'rakeback:' || p_period_id::text
  );

  PERFORM set_config('app.ledger_club_id', '', true);

  SELECT cm.chip_balance INTO v_balance
    FROM public.club_members cm
   WHERE cm.user_id = v_period.user_id AND cm.club_id = v_period.club_id;

  INSERT INTO public.wallet_transactions
    (user_id, wallet_type, amount, type, category, description, related_entity_id, balance_after)
  VALUES
    (v_period.user_id, 'PLAYER', v_payout, 'credit', 'rakeback',
     'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
     v_payout_id, v_balance);

  UPDATE public.rakeback_periods
     SET status = 'paid', paid_at = NOW(), deferred_reason = NULL, deferred_at = NULL
   WHERE id = p_period_id;

  RETURN jsonb_build_object('success', true, 'period_id', p_period_id,
    'rake_total', v_rake_total, 'rakeback_rate', v_rate,
    'payout', v_payout, 'payout_id', v_payout_id, 'club_id', v_period.club_id,
    'from_rollup', v_from_rollup, 'funded_from', 'club_chip_treasury');
END;
$function$;

-- THE BATCH ASKS THE CLUB BEFORE IT ASKS 1,769 PERIODS -------------------------

CREATE OR REPLACE FUNCTION public.fn_settle_club_rakeback_batch(
  p_club_id uuid,
  p_max_periods integer DEFAULT 40,
  p_budget_seconds numeric DEFAULT 4.0,
  p_max_warm_days integer DEFAULT 2)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_period     record;
  v_day        record;
  v_res        jsonb;
  v_settled    int := 0;
  v_deferred   int := 0;
  v_warmed     int := 0;
  v_total      numeric := 0;
  v_reasons    jsonb := '{}'::jsonb;
  v_reason     text;
  v_remaining  int;
  v_budget     numeric;
  v_elapsed    numeric;
  v_treasury   numeric;
  v_smallest   numeric;
  v_owed       numeric;
BEGIN
  IF p_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_club_id required');
  END IF;

  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL
          OR (NOT public.fn_is_platform_admin()
              AND NOT EXISTS (SELECT 1 FROM public.clubs c
                               WHERE c.id = p_club_id AND c.owner_id = auth.uid()))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorised');
  END IF;

  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
      'periods_settled', 0, 'total_payout', 0, 'deferred', 0,
      'note', 'platform_frozen', 'clock_ran_out', false);
  END IF;

  v_budget := GREATEST(COALESCE(p_budget_seconds, 4.0), 0.5);
  IF p_max_periods IS NULL OR p_max_periods < 1 THEN p_max_periods := 40; END IF;

  SELECT count(*), COALESCE(min(NULLIF(COALESCE(rakeback_amount, rakeback_earned, 0), 0)), 0),
         COALESCE(sum(COALESCE(rakeback_amount, rakeback_earned, 0)), 0)
    INTO v_remaining, v_smallest, v_owed
    FROM public.rakeback_periods
   WHERE club_id = p_club_id AND status = 'pending' AND period_end < CURRENT_DATE;

  IF v_remaining = 0 THEN
    RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
      'periods_settled', 0, 'total_payout', 0, 'deferred', 0,
      'periods_remaining', 0, 'note', 'nothing due', 'clock_ran_out', false);
  END IF;

  -- ONE READ instead of a per-period discovery. A club that cannot fund even
  -- its smallest pending payout is deferred whole: no basis is computed, no
  -- treasury is locked, and the shortfall is the answer rather than a thousand
  -- identical refusals.
  SELECT COALESCE(chip_treasury, 0) INTO v_treasury FROM public.clubs WHERE id = p_club_id;
  IF v_treasury < v_smallest THEN
    UPDATE public.rakeback_periods
       SET deferred_reason = 'insufficient_club_treasury',
           deferred_at = NOW(),
           defer_count = defer_count + 1
     WHERE club_id = p_club_id AND status = 'pending' AND period_end < CURRENT_DATE
       AND deferred_reason IS DISTINCT FROM 'insufficient_club_treasury';

    RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
      'periods_settled', 0, 'total_payout', 0,
      'deferred', v_remaining,
      'deferred_reasons', jsonb_build_object('insufficient_club_treasury', v_remaining),
      'periods_remaining', v_remaining,
      'treasury', round(v_treasury, 2), 'owed', round(v_owed, 2),
      'shortfall', round(v_owed - v_treasury, 2),
      'note', 'club cannot fund its smallest pending payout',
      'elapsed_seconds', round(extract(epoch FROM (clock_timestamp() - v_started))::numeric, 3),
      'clock_ran_out', false);
  END IF;

  FOR v_day IN
    SELECT DISTINCT d::date AS day
      FROM public.rakeback_periods rp
      CROSS JOIN LATERAL generate_series(rp.period_start, rp.period_end, interval '1 day') d
     WHERE rp.club_id = p_club_id
       AND rp.status = 'pending'
       AND rp.period_end < CURRENT_DATE
       AND NOT EXISTS (SELECT 1 FROM public.rakeback_daily_state s
                        WHERE s.club_id = p_club_id AND s.day = d::date)
     ORDER BY 1
     LIMIT GREATEST(COALESCE(p_max_warm_days, 2), 0)
  LOOP
    EXIT WHEN extract(epoch FROM (clock_timestamp() - v_started)) > v_budget * 0.6;
    PERFORM public.fn_rakeback_recompute_day(p_club_id, v_day.day, false);
    v_warmed := v_warmed + 1;
  END LOOP;

  FOR v_period IN
    SELECT id FROM public.rakeback_periods
     WHERE club_id = p_club_id AND status = 'pending'
       AND period_end < CURRENT_DATE
     ORDER BY period_end, id
     LIMIT p_max_periods
  LOOP
    EXIT WHEN extract(epoch FROM (clock_timestamp() - v_started)) > v_budget;

    v_res := public.fn_close_settlement_period(v_period.id);

    IF COALESCE((v_res->>'success')::boolean, false) THEN
      v_settled := v_settled + 1;
      v_total   := v_total + COALESCE((v_res->>'payout')::numeric, 0);
    ELSE
      v_deferred := v_deferred + 1;
      v_reason   := COALESCE(v_res->>'deferred', v_res->>'error', 'unknown');
      v_reasons  := jsonb_set(v_reasons, ARRAY[v_reason],
                      to_jsonb(COALESCE((v_reasons->>v_reason)::int, 0) + 1), true);
    END IF;
  END LOOP;

  SELECT count(*) INTO v_remaining FROM public.rakeback_periods
   WHERE club_id = p_club_id AND status = 'pending' AND period_end < CURRENT_DATE;

  v_elapsed := round(extract(epoch FROM (clock_timestamp() - v_started))::numeric, 3);

  RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
    'periods_settled', v_settled, 'total_payout', round(v_total, 2),
    'deferred', v_deferred, 'deferred_reasons', v_reasons,
    'days_warmed', v_warmed, 'periods_remaining', v_remaining,
    'treasury', round(v_treasury, 2),
    'elapsed_seconds', v_elapsed,
    'clock_ran_out', v_elapsed > v_budget);
END;
$function$;

CREATE OR REPLACE FUNCTION public.settle_club_rakeback(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.fn_settle_club_rakeback_batch(p_club_id, 40, 4.0, 2);
END;
$function$;

-- ASSERTIONS -------------------------------------------------------------------

DO $assert$
DECLARE v_src text; v_member_at int; v_basis_at int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_close_settlement_period' AND pronamespace='public'::regnamespace;

  v_member_at := position('no_membership_at_earning_club' in v_src);
  v_basis_at  := position('fn_rake_shares_for_record' in v_src);
  IF v_member_at = 0 OR v_basis_at = 0 THEN
    RAISE EXCEPTION 'the payer lost one of its two branches';
  END IF;
  IF v_member_at > v_basis_at THEN
    RAISE EXCEPTION 'the membership refusal still runs AFTER the rake scan - the exact defect this migration exists to fix';
  END IF;
  IF position('fn_platform_frozen' in v_src) > v_basis_at THEN
    RAISE EXCEPTION 'the freeze check still runs after the rake scan';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_settle_club_rakeback_batch' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%cannot fund its smallest pending payout%' THEN
    RAISE EXCEPTION 'the batch does not pre-flight the club treasury';
  END IF;
  IF v_src NOT LIKE '%fn_is_platform_admin%' THEN
    RAISE EXCEPTION 'a platform admin still cannot settle a club they do not own';
  END IF;
END
$assert$;

COMMIT;
