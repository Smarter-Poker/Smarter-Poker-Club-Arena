-- Candidate only. Preserves existing legacy funding owner and financial rights.
BEGIN;
DO $gate$ BEGIN
 IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_claim_rakeback(uuid)'::regprocedure)) <> '930e4b70fa3580c010abe99e23181598' THEN RAISE EXCEPTION 'Legacy player owner changed since captured review'; END IF;
 EXECUTE $body$CREATE OR REPLACE FUNCTION public.fn_claim_rakeback(p_club_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user    uuid := (SELECT auth.uid());
  v_period  record;
  v_res     jsonb;
  v_count   int := 0;
  v_total   numeric := 0;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication required');
  END IF;

  PERFORM public.fn_lock_rakeback_payer_clubs(ARRAY(SELECT DISTINCT club_id FROM public.rakeback_periods
   WHERE user_id=v_user AND status='pending' AND (p_club_id IS NULL OR club_id=p_club_id) ORDER BY club_id));

  FOR v_period IN
    SELECT id FROM public.rakeback_periods
     WHERE user_id = v_user
       AND status = 'pending'
       AND (p_club_id IS NULL OR club_id = p_club_id)
     ORDER BY club_id,period_start,id
     FOR UPDATE
  LOOP
    v_res := public.fn_close_settlement_period(v_period.id);
    IF COALESCE((v_res->>'success')::boolean, false) THEN
      v_total := v_total + COALESCE((v_res->>'payout')::numeric, 0);
      IF COALESCE((v_res->>'payout')::numeric, 0) > 0 THEN
        v_count := v_count + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'periods_claimed', v_count, 'total_payout', v_total);
END;
$function$
$body$;
END $gate$;
DO $gate$ BEGIN
 IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_close_settlement_period(uuid)'::regprocedure)) <> '5f1b3b29c972620ca06143a2f58444c9' THEN RAISE EXCEPTION 'Legacy player owner changed since captured review'; END IF;
 EXECUTE $body$CREATE OR REPLACE FUNCTION public.fn_close_settlement_period(p_period_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_period         record;
  v_admitted_club uuid;
  v_rake_total     numeric;
  v_rate           numeric;
  v_payout         numeric;
  v_payout_id      uuid;
  v_days_needed    int;
  v_days_have      int;
  v_from_rollup    boolean := true;
  v_has_captured boolean;
  v_is_member      boolean;
  v_balance        numeric;
  v_debit          jsonb;
  v_treasury       numeric;
BEGIN
  SELECT club_id INTO v_admitted_club FROM public.rakeback_periods WHERE id=p_period_id;
  PERFORM public.fn_lock_rakeback_payer_clubs(ARRAY[v_admitted_club]);
  SELECT * INTO v_period FROM public.rakeback_periods WHERE id = p_period_id FOR UPDATE;
  IF FOUND AND v_period.club_id IS DISTINCT FROM v_admitted_club THEN RAISE EXCEPTION 'Rakeback period scope changed during admission' USING ERRCODE='40001'; END IF;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'period not found');
  END IF;

  IF v_period.status IN ('paid', 'expired') THEN
    RETURN jsonb_build_object('success', true, 'skipped', v_period.status, 'period_id', p_period_id);
  END IF;

  -- WHO IS ASKING. A grant is not an authorization check: it lives outside
  -- the function and CREATE OR REPLACE carries it forward unexamined. This
  -- function debits a treasury and credits a wallet, so it asks.
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL
          OR (auth.uid() <> v_period.user_id
              AND NOT public.fn_is_platform_admin()
              AND NOT EXISTS (SELECT 1 FROM public.clubs c
                               WHERE c.id = v_period.club_id
                                 AND c.owner_id = auth.uid()))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorised');
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

  -- Can this club fund what this period is already believed to be worth? The
  -- estimate is the writer's own last computation, it is used ONLY to refuse,
  -- and refusing here costs one indexed row where continuing costs a full rake
  -- scan for a payment fn_debit_treasury would decline at the end of it.
  v_has_captured := public.fn_ca_rakeback_period_has_captured(v_period.club_id,v_period.user_id,v_period.period_start,v_period.period_end);
  IF NOT v_has_captured AND COALESCE(v_period.rakeback_amount, v_period.rakeback_earned, 0) > 0 THEN
    SELECT COALESCE(c.chip_treasury, 0) INTO v_treasury
      FROM public.clubs c WHERE c.id = v_period.club_id;
    IF v_treasury < COALESCE(v_period.rakeback_amount, v_period.rakeback_earned, 0) THEN
      UPDATE public.rakeback_periods
         SET deferred_reason = 'insufficient_club_treasury',
             deferred_at = NOW(), defer_count = defer_count + 1
       WHERE id = p_period_id;
      RETURN jsonb_build_object('success', false, 'deferred', 'insufficient_club_treasury',
        'period_id', p_period_id, 'club_id', v_period.club_id,
        'estimated_payout', COALESCE(v_period.rakeback_amount, v_period.rakeback_earned, 0),
        'treasury', round(v_treasury, 2), 'checked', 'before_basis');
    END IF;
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

  IF v_has_captured THEN
    v_from_rollup:=false;
    v_rake_total:=public.fn_ca_legacy_player_rake(v_period.club_id,v_period.user_id,v_period.period_start,v_period.period_end);
  ELSIF v_days_have >= v_days_needed THEN
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
       AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id, r.table_id, r.metadata)
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
     ROUND(v_rate * 100, 2), round(v_payout, 2), 'paid', NOW())
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

  /* THE POINTER IS WRITTEN WHERE THE MONEY MOVED (2026-09-08). The credit
     above already stamps related_entity_id = this payout, so the link has
     always existed in ONE direction. rakeback_period_payouts.wallet_
     transaction_id was never written back, on any of 2,704 rows since the
     table was created, and fn_ca_settlement_correctness_check reads that
     direction - so every paid rakeback looked like money with no evidence.
     PERFORM discards what the credit returns and the function returns only
     a boolean, so the id is read back from the row it just stamped. */
  PERFORM set_config('app.ledger_maintenance',
                     'rakeback payout evidence pointer', true);
  UPDATE public.rakeback_period_payouts p
     SET wallet_transaction_id = w.id
    FROM public.wallet_transactions w
   WHERE p.id = v_payout_id AND w.related_entity_id = v_payout_id
     AND p.wallet_transaction_id IS NULL;
  PERFORM set_config('app.ledger_maintenance', '', true);



  UPDATE public.rakeback_periods
     SET status = 'paid', paid_at = NOW(), deferred_reason = NULL, deferred_at = NULL
   WHERE id = p_period_id;

  RETURN jsonb_build_object('success', true, 'period_id', p_period_id,
    'rake_total', v_rake_total, 'rakeback_rate', v_rate,
    'payout', v_payout, 'payout_id', v_payout_id, 'club_id', v_period.club_id,
    'from_rollup', v_from_rollup, 'funded_from', 'club_chip_treasury');
END;
$function$
$body$;
END $gate$;
COMMIT;
