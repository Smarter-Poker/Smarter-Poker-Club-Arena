-- Dormant atomic entrypoint. Generated from the exact reviewed 01 and 02 bodies.
BEGIN;
-- BEGIN SOURCE 01-legacy-maturity-only.sql
-- Dormant legacy-only candidate. No captured-source schema or capability prerequisite.

SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
DO $gate$ BEGIN
 IF md5((SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.fn_claim_rakeback(uuid)'))) IS DISTINCT FROM '930e4b70fa3580c010abe99e23181598'
  OR md5((SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.fn_close_settlement_period(uuid)'))) IS DISTINCT FROM '5f1b3b29c972620ca06143a2f58444c9'
 THEN RAISE EXCEPTION 'Legacy rakeback owners changed since reviewed maturity baseline'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid IN(to_regprocedure('public.fn_claim_rakeback(uuid)'),to_regprocedure('public.fn_close_settlement_period(uuid)')) AND (NOT prosecdef OR pg_get_userbyid(proowner)<>'postgres'))
 THEN RAISE EXCEPTION 'Legacy rakeback execution authority changed'; END IF;
END $gate$;
CREATE OR REPLACE FUNCTION public.fn_claim_rakeback(p_club_id uuid DEFAULT NULL::uuid)
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

  FOR v_period IN
    SELECT id FROM public.rakeback_periods
     WHERE user_id = v_user
       AND status = 'pending'
       AND (period_end+1)::timestamp AT TIME ZONE 'UTC' <= statement_timestamp()
       AND (p_club_id IS NULL OR club_id = p_club_id)
     ORDER BY period_start
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
;
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
  v_treasury       numeric;
BEGIN
  SELECT * INTO v_period FROM public.rakeback_periods WHERE id = p_period_id FOR UPDATE;
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

  -- The existing batch payer selects closed periods. Direct callers must too.
  IF (v_period.period_end+1)::timestamp AT TIME ZONE 'UTC' > statement_timestamp() THEN
    RETURN jsonb_build_object('success',false,'deferred','earning_period_open',
      'period_id',p_period_id,'matures_at',(v_period.period_end+1)::timestamp AT TIME ZONE 'UTC');
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
  IF COALESCE(v_period.rakeback_amount, v_period.rakeback_earned, 0) > 0 THEN
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
       AND r.created_at >= v_period.period_start::timestamp AT TIME ZONE 'UTC'
       AND r.created_at <  (v_period.period_end + 1)::timestamp AT TIME ZONE 'UTC'
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

  -- Bind the existing payout receipt only after its wallet row has been inserted.
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
;
-- An old zero-payout body has no wallet row. Every successful close updates status.
CREATE FUNCTION public.fn_ca_legacy_period_maturity() RETURNS trigger
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
BEGIN
 IF NEW.status='paid' AND OLD.status IS DISTINCT FROM 'paid'
  AND (NEW.period_end+1)::timestamp AT TIME ZONE 'UTC' > statement_timestamp() THEN
  RAISE EXCEPTION 'Legacy period payment requires a closed earning period' USING ERRCODE='40001';
 END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_period_maturity() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER ca_legacy_period_maturity BEFORE UPDATE OF status ON public.rakeback_periods
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_legacy_period_maturity();

-- END SOURCE 01-legacy-maturity-only.sql
-- BEGIN SOURCE 02-legacy-single-payer.sql
-- Dormant legacy-only duplicate-payer successor; apply after 01 in the same reviewed release.

SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
DO $gate$ BEGIN
 IF md5((SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.fn_claim_rakeback(uuid)'))) IS DISTINCT FROM '64806f11b46e776083477d4c7dfad971'
  OR md5((SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.fn_close_settlement_period(uuid)'))) IS DISTINCT FROM '075d86f8bdf8050531fc0732dda05a01'
  OR md5((SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)'))) IS DISTINCT FROM '5234e460b1ea1f666fbc6bac7a9a1b17'
 THEN RAISE EXCEPTION 'Legacy duplicate-payer baseline changed'; END IF;
END $gate$;
CREATE OR REPLACE FUNCTION public.fn_lock_rakeback_payer_clubs(p_club_ids uuid[]) RETURNS void
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE v_club uuid;
BEGIN
 FOR v_club IN SELECT DISTINCT c FROM unnest(p_club_ids) c WHERE c IS NOT NULL ORDER BY c LOOP
  PERFORM pg_advisory_xact_lock(hashtext('club-arena:rakeback-payer'),hashtext(v_club::text));
 END LOOP;
END $f$;
REVOKE ALL ON FUNCTION public.fn_lock_rakeback_payer_clubs(uuid[]) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_claim_rakeback(p_club_id uuid DEFAULT NULL::uuid)
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
  v_admitted_clubs uuid[];
  v_total   numeric := 0;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication required');
  END IF;

  v_admitted_clubs := ARRAY(SELECT DISTINCT club_id FROM public.rakeback_periods
   WHERE user_id=v_user AND status='pending'
    AND (period_end+1)::timestamp AT TIME ZONE 'UTC' <= statement_timestamp()
    AND (p_club_id IS NULL OR club_id=p_club_id) ORDER BY club_id);
  PERFORM public.fn_lock_rakeback_payer_clubs(v_admitted_clubs);
  FOR v_period IN
    SELECT id FROM public.rakeback_periods
     WHERE user_id = v_user
       AND club_id = ANY(v_admitted_clubs)
       AND status = 'pending'
       AND (period_end+1)::timestamp AT TIME ZONE 'UTC' <= statement_timestamp()
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
;
CREATE OR REPLACE FUNCTION public.fn_close_settlement_period(p_period_id uuid)
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
  v_is_member      boolean;
  v_balance        numeric;
  v_debit          jsonb;
  v_treasury       numeric;
  v_ledger_category text;
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

  -- The existing batch payer selects closed periods. Direct callers must too.
  IF (v_period.period_end+1)::timestamp AT TIME ZONE 'UTC' > statement_timestamp() THEN
    RETURN jsonb_build_object('success',false,'deferred','earning_period_open',
      'period_id',p_period_id,'matures_at',(v_period.period_end+1)::timestamp AT TIME ZONE 'UTC');
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
  IF COALESCE(v_period.rakeback_amount, v_period.rakeback_earned, 0) > 0 THEN
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
       AND r.created_at >= v_period.period_start::timestamp AT TIME ZONE 'UTC'
       AND r.created_at <  (v_period.period_end + 1)::timestamp AT TIME ZONE 'UTC'
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

  v_ledger_category:=current_setting('app.ledger_category',true);
  PERFORM public.atomic_credit_wallet_and_log(
    v_period.user_id, v_payout, 'rakeback',
    'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
    NULL, NULL, v_payout_id, 'rakeback:' || p_period_id::text
  );


  PERFORM set_config('app.ledger_club_id', '', true);
  PERFORM set_config('app.ledger_category',coalesce(v_ledger_category,''),true);

  SELECT cm.chip_balance INTO v_balance
    FROM public.club_members cm
   WHERE cm.user_id = v_period.user_id AND cm.club_id = v_period.club_id;

  INSERT INTO public.wallet_transactions
    (user_id, wallet_type, amount, type, category, description, related_entity_id, balance_after)
  VALUES
    (v_period.user_id, 'PLAYER', v_payout, 'credit', 'rakeback',
     'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
     v_payout_id, v_balance);

  -- Bind the existing payout receipt only after its wallet row has been inserted.
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
;
-- An old zero-payout body has no wallet row. Every successful close updates status.
CREATE OR REPLACE FUNCTION public.fn_settle_round3_agents_to_players(p_union_id uuid,p_period_start timestamptz,p_period_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $f$
DECLARE r record;g record;v_items jsonb:='[]'::jsonb;v_agent uuid;v_payout uuid;v_wallet uuid;v_agent_before numeric;v_agent_after numeric;
 v_player_before numeric;v_player_after numeric;v_owed numeric;v_rake numeric;v_rate numeric;
 v_admitted_clubs uuid[];
 v_paid numeric:=0;v_payees integer:=0;v_short integer:=0;v_detail jsonb:='[]';v_skip text;
BEGIN
 IF EXISTS(SELECT 1 FROM settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active=true)
 THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end<=p_period_start
  OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
 THEN RETURN jsonb_build_object('round',3,'name','agents_to_players','success',false,'error','bad_params','amount',0,'payees',0,'shortfalls',0,'detail','[]'::jsonb); END IF;
 v_admitted_clubs := ARRAY(SELECT club_id FROM public.union_clubs WHERE union_id=p_union_id ORDER BY club_id);
 PERFORM public.fn_lock_rakeback_payer_clubs(v_admitted_clubs);
 -- Lock each exact period before calculating or choosing its legacy payer.
 FOR r IN SELECT rp.* FROM rakeback_periods rp
 JOIN union_clubs uc ON uc.club_id=rp.club_id AND uc.union_id=p_union_id
 WHERE rp.status='pending' AND rp.club_id=ANY(v_admitted_clubs)
 AND rp.period_start >= (p_period_start AT TIME ZONE 'UTC')::date
 AND (rp.period_end + 1)::timestamp AT TIME ZONE 'UTC' <= p_period_end
 AND (rp.period_end + 1)::timestamp AT TIME ZONE 'UTC' <= statement_timestamp()
 ORDER BY rp.club_id,rp.period_start,rp.id FOR UPDATE OF rp
 LOOP
  IF EXISTS(SELECT 1 FROM rakeback_period_payouts x WHERE x.rakeback_period_id=r.id AND x.user_id=r.user_id) THEN CONTINUE; END IF;
  SELECT agent_id,chip_balance INTO v_agent,v_player_before FROM club_members WHERE club_id=r.club_id AND user_id=r.user_id;
  IF v_agent IS NULL THEN CONTINUE; END IF;
  IF v_agent=r.user_id THEN RAISE EXCEPTION 'Legacy rakeback payer cannot equal beneficiary' USING ERRCODE='23514'; END IF;
  v_owed:=r.rakeback_amount;v_rake:=coalesce(r.rake_generated,r.total_rake_paid);v_rate:=r.rakeback_rate;
  -- Negative offsets and missing receipt basis require explicit repair, not
  -- silent exclusion from the installed aggregate funding decision.
  IF v_owed<0 THEN RAISE EXCEPTION 'Legacy rakeback aggregate contains a negative period' USING ERRCODE='23514'; END IF;
  IF v_owed IS NULL OR v_owed=0 THEN CONTINUE; END IF;
  IF v_rake IS NULL OR v_rake<0 OR v_rake::text IN('NaN','Infinity','-Infinity')
    OR v_rate IS NULL OR v_rate<0 OR v_rate>1 OR v_rate::text IN('NaN','Infinity','-Infinity')
  THEN RAISE EXCEPTION 'Legacy rakeback receipt basis requires repair' USING ERRCODE='23514'; END IF;
  IF v_owed::text IN('NaN','Infinity','-Infinity') OR v_owed<>round(v_owed,2)
  THEN RAISE EXCEPTION 'Legacy rakeback must be finite whole cents' USING ERRCODE='23514'; END IF;
  v_items:=v_items||jsonb_build_object('id',r.id,'club_id',r.club_id,'user_id',r.user_id,
    'agent',v_agent,'owed',v_owed,'rake',v_rake,'rate',v_rate);
 END LOOP;
 -- Preserve the installed all-or-nothing funding decision for each player group.
 -- Exact membership and amounts were pinned while every period row was locked.
 FOR g IN SELECT x.club_id,x.user_id,x.agent,sum(x.owed) AS owed
  FROM jsonb_to_recordset(v_items) AS x(id uuid,club_id uuid,user_id uuid,agent uuid,owed numeric,rake numeric,rate numeric)
  GROUP BY x.club_id,x.user_id,x.agent ORDER BY x.club_id,x.agent,x.user_id
 LOOP
  v_agent:=g.agent;
  PERFORM 1 FROM club_members WHERE club_id=g.club_id AND user_id IN(v_agent,g.user_id) ORDER BY user_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM club_members WHERE club_id=g.club_id AND user_id=g.user_id AND agent_id=v_agent)
  THEN RAISE EXCEPTION 'Legacy payer changed during admission' USING ERRCODE='40001'; END IF;
  SELECT chip_balance INTO v_agent_before FROM club_members WHERE club_id=g.club_id AND user_id=v_agent;
  IF coalesce(v_agent_before,0)<g.owed THEN
   v_short:=v_short+1;v_detail:=v_detail||jsonb_build_object('agent',v_agent,'player',g.user_id,'owed',g.owed,'agent_balance',coalesce(v_agent_before,0),'skipped',true);CONTINUE;
  END IF;
  FOR r IN SELECT x.* FROM jsonb_to_recordset(v_items)
    AS x(id uuid,club_id uuid,user_id uuid,agent uuid,owed numeric,rake numeric,rate numeric)
    WHERE x.club_id=g.club_id AND x.user_id=g.user_id AND x.agent=g.agent ORDER BY x.id
  LOOP
   v_owed:=r.owed;v_rake:=r.rake;v_rate:=r.rate;
   SELECT chip_balance INTO v_agent_before FROM club_members WHERE club_id=r.club_id AND user_id=v_agent;
   SELECT coalesce(chip_balance,0) INTO v_player_before FROM club_members WHERE club_id=r.club_id AND user_id=r.user_id;
  INSERT INTO rakeback_period_payouts(rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at)
  VALUES(r.id,r.club_id,r.user_id,v_rake,round(v_rate*100,2),v_owed,'paid',now())
  ON CONFLICT(rakeback_period_id,user_id) DO NOTHING RETURNING id INTO v_payout;
  IF v_payout IS NULL THEN RAISE EXCEPTION 'Legacy period receipt changed after admission' USING ERRCODE='40001'; END IF;
  v_skip:=current_setting('app.ledger_autoskip_club_members',true);
  PERFORM set_config('app.ledger_autoskip_club_members','1',true);
  UPDATE club_members SET chip_balance=chip_balance-v_owed,updated_at=now() WHERE club_id=r.club_id AND user_id=v_agent RETURNING chip_balance INTO v_agent_after;
  UPDATE club_members SET chip_balance=coalesce(chip_balance,0)+v_owed,updated_at=now() WHERE club_id=r.club_id AND user_id=r.user_id RETURNING chip_balance INTO v_player_after;
  PERFORM set_config('app.ledger_autoskip_club_members',coalesce(v_skip,''),true);
  IF v_agent_after IS NULL OR v_player_after IS NULL OR v_agent_before-v_agent_after<>v_owed OR v_player_after-v_player_before<>v_owed
  THEN RAISE EXCEPTION 'Legacy rakeback balance conservation failed' USING ERRCODE='23514'; END IF;
  INSERT INTO wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
  VALUES(r.user_id,'PLAYER','credit',v_owed,'rakeback','Round 3: agent -> player rakeback [club wallet]',v_player_after,v_payout) RETURNING id INTO v_wallet;
  PERFORM set_config('app.ledger_maintenance','rakeback payout evidence pointer',true);
  UPDATE rakeback_period_payouts SET wallet_transaction_id=v_wallet WHERE id=v_payout;
  PERFORM set_config('app.ledger_maintenance','',true);
  INSERT INTO chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata)
  VALUES(coalesce(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),'player_wallet',v_agent,'player_wallet',r.user_id,v_owed,'rakeback',r.club_id,p_union_id,
   'Round 3: agent -> player rakeback','round3-period:'||r.id::text,
   jsonb_build_object('period_id',r.id,'period_start',p_period_start,'period_end',p_period_end,'payout_id',v_payout,'wallet_transaction_id',v_wallet));
  UPDATE rakeback_periods SET status='paid',paid_at=now() WHERE id=r.id;
  v_paid:=v_paid+v_owed;
  END LOOP;
  v_payees:=v_payees+1;
 END LOOP;
 RETURN jsonb_build_object('round',3,'name','agents_to_players','payees',v_payees,'amount',round(v_paid,2),'shortfalls',v_short,'detail',v_detail);
END $f$;
-- Table-side receipt fence also runs for previously compiled Round3 calls.
CREATE FUNCTION public.fn_ca_legacy_round3_wallet_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE v_period record; v_legacy numeric;
BEGIN
 IF NEW.category='rakeback' AND NEW.description='Round 3: agent -> player rakeback [club wallet]' THEN
  IF NEW.related_entity_id IS NULL OR NOT EXISTS(SELECT 1 FROM rakeback_period_payouts p
   JOIN rakeback_periods rp ON rp.id=p.rakeback_period_id
   WHERE p.id=NEW.related_entity_id AND p.user_id=NEW.user_id AND p.club_id=rp.club_id AND p.user_id=rp.user_id
    AND p.payout_amount=NEW.amount AND p.status='paid' AND p.wallet_transaction_id IS NULL AND rp.status='pending')
  THEN RAISE EXCEPTION 'Round3 requires the unique unpaid period receipt' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.category='rakeback' AND NEW.related_entity_id IS NOT NULL THEN
  SELECT rp.*,receipt.payout_amount AS receipt_amount,receipt.user_id AS receipt_user INTO v_period
  FROM rakeback_period_payouts receipt JOIN rakeback_periods rp ON rp.id=receipt.rakeback_period_id
  WHERE receipt.id=NEW.related_entity_id;
  IF FOUND AND (v_period.period_end+1)::timestamp AT TIME ZONE 'UTC' > statement_timestamp() THEN
   RAISE EXCEPTION 'Legacy period payment requires a closed earning period' USING ERRCODE='40001';
  END IF;

 END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_round3_wallet_receipt() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER ca_legacy_round3_wallet_receipt BEFORE INSERT ON public.wallet_transactions FOR EACH ROW EXECUTE FUNCTION public.fn_ca_legacy_round3_wallet_receipt();


-- END SOURCE 02-legacy-single-payer.sql
COMMIT;
