BEGIN;
DO $baseline$ BEGIN
IF md5(pg_get_functiondef('public.fn_tournament_payout_reconcile(uuid,boolean)'::regprocedure)) <> 'b30cd816639303816886dc0c0d2d77f4' THEN RAISE EXCEPTION 'reconciliation baseline changed'; END IF;
END $baseline$;
CREATE OR REPLACE FUNCTION public.fn_tournament_payout_reconcile(p_tournament_id uuid, p_apply boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t                record;
  v_struct         jsonb;
  v_trimmed        jsonb;
  v_field          int;
  v_pool           numeric;
  v_last_place     int;
  v_total_bp       numeric;
  v_pool_cents     numeric;
  v_remaining      numeric;
  v_cents          numeric;
  v_expected       numeric;
  v_paid           numeric;
  v_paid_place     numeric;
  v_paid_eff       numeric;
  v_place_others   uuid[];
  v_delta          numeric;
  v_holder         uuid;
  v_holders        int;
  v_credited       boolean;
  v_settle         jsonb;
  v_settle_paid    numeric;
  v_actions        jsonb := '[]'::jsonb;
  v_issues         jsonb := '[]'::jsonb;
  v_total_expected numeric := 0;
  v_total_paid     numeric := 0;
  v_total_topup    numeric := 0;
  v_total_settled  numeric := 0;
  v_only_accepted  boolean;
  v_was_accepted   boolean;
  v_has_record     boolean;
  r                record;
BEGIN
  SELECT id, prize_pool, payout_structure, status, variant, tournament_type, name
    INTO t
    FROM tournaments WHERE id = p_tournament_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  IF COALESCE(t.variant, '') = 'satellite'
     OR upper(COALESCE(t.tournament_type, '')) = 'SATELLITE' THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'satellite_awards_seats');
  END IF;

  IF COALESCE(t.status, '') <> 'COMPLETED' THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'not_completed', 'status', t.status);
  END IF;

  v_pool := round(COALESCE(t.prize_pool, 0), 2);

  BEGIN
    v_struct := CASE WHEN jsonb_typeof(t.payout_structure::jsonb) = 'array'
                     THEN t.payout_structure::jsonb ELSE '[]'::jsonb END;
  EXCEPTION WHEN OTHERS THEN
    v_struct := '[]'::jsonb;
  END;

  IF v_pool <= 0 OR jsonb_array_length(v_struct) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'no_pool_or_structure',
                              'prize_pool', v_pool);
  END IF;

  /* Is there an authoritative record for this event at all? */
  SELECT EXISTS (SELECT 1 FROM public.tournament_payouts tpo
                  WHERE tpo.tournament_id = p_tournament_id)
    INTO v_has_record;

  SELECT count(*) INTO v_field
    FROM tournament_players tp WHERE tp.tournament_id = p_tournament_id;

  IF COALESCE(v_field, 0) >= 1 THEN
    SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'place')::int), '[]'::jsonb)
      INTO v_trimmed
      FROM jsonb_array_elements(v_struct) e
     WHERE (e->>'place')::int <= v_field;

    IF jsonb_array_length(v_trimmed) > 0
       AND jsonb_array_length(v_trimmed) < jsonb_array_length(v_struct) THEN
      v_struct := v_trimmed;
    END IF;
  END IF;

  SELECT max((e->>'place')::int) INTO v_last_place
    FROM jsonb_array_elements(v_struct) e;

  SELECT COALESCE(SUM(round((e->>'percentage')::numeric * 100)), 0)
    INTO v_total_bp
    FROM jsonb_array_elements(v_struct) e;

  IF v_total_bp <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'structure_has_no_percentages');
  END IF;

  v_pool_cents := round(v_pool * 100);
  v_remaining  := v_pool_cents;

  FOR r IN
    SELECT (e->>'place')::int                      AS place,
           round((e->>'percentage')::numeric * 100) AS bp
      FROM jsonb_array_elements(v_struct) e
     ORDER BY (e->>'place')::int
  LOOP
    IF r.place = v_last_place THEN
      v_cents := GREATEST(v_remaining, 0);
    ELSE
      v_cents := LEAST(v_remaining, round(v_pool_cents * r.bp / v_total_bp));
      v_cents := GREATEST(v_cents, 0);
    END IF;
    v_remaining := v_remaining - v_cents;

    v_expected := v_cents / 100.0;
    v_total_expected := v_total_expected + v_expected;

    SELECT count(*), (array_agg(tp.user_id ORDER BY tp.user_id))[1]
      INTO v_holders, v_holder
      FROM tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.position = r.place;

    v_paid_place   := 0;
    v_place_others := ARRAY[]::uuid[];

    IF v_holders = 1 THEN
      IF v_has_record THEN
        /* THE AUTHORITATIVE ANSWER. One row per movement of money, keyed
           uniquely, written only after the credit returned true. Bounty and
           mystery-bounty money is excluded: it is funded from the bounty pool,
           not from prize_pool, and counting it here used to make a player look
           square when the structure still owed them.
           2026-09-02: 'overlay_backpay' added. A guarantee overlay top-up IS
           prize_pool money. While it was missing from this list the reconciler
           could not see 1,703.00 chips of back-payment and paid 1,007.80 of it
           a second time.
           2026-09-02 (Lane A3): a row written by fn_settle_tournament_obligation
           (idempotency_key 'obl:%') is prize-pool money whatever source label
           the caller passed - the engine settles under 'engine.*' names. */
        SELECT round(COALESCE(SUM(tpo.amount), 0), 2) INTO v_paid
          FROM public.tournament_payouts tpo
         WHERE tpo.tournament_id = p_tournament_id
           AND tpo.user_id = v_holder
           AND (tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                               'late_reg_adjustment', 'clawback',
                               'final_table_deal', 'spin_backpay',
                               'overlay_backpay')
                OR tpo.idempotency_key LIKE 'tourney:%:obl:%');

        /* A PLACE IS PAID ONCE, NO MATTER WHO HOLDS IT (2026-09-02).
           What this place has already cost, to ANYBODY. The obligation is per
           place; reading only the current holder let a place that changed hands
           after settlement be paid in full a second time -- 81 places, 49
           events, 21,206.93 chips. */
        SELECT round(COALESCE(SUM(tpo.amount), 0), 2),
               COALESCE(array_agg(DISTINCT tpo.user_id)
                        FILTER (WHERE tpo.user_id <> v_holder), ARRAY[]::uuid[])
          INTO v_paid_place, v_place_others
          FROM public.tournament_payouts tpo
         WHERE tpo.tournament_id = p_tournament_id
           AND tpo.position = r.place
           AND (tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                               'late_reg_adjustment', 'clawback',
                               'final_table_deal', 'spin_backpay',
                               'overlay_backpay')
                OR tpo.idempotency_key LIKE 'tourney:%:obl:%');
      ELSE
        /* No record for this event. Fall back to the ledger exactly as before
           rather than reading "no record" as "nothing was paid". */
        SELECT round(COALESCE(SUM(
                 CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount)
                      ELSE wt.amount END
               ), 0), 2) INTO v_paid
          FROM wallet_transactions wt
         WHERE wt.related_entity_id = p_tournament_id
           AND wt.category = 'prize'
           AND wt.user_id = v_holder;
      END IF;
    ELSE
      v_paid := NULL;
    END IF;

    IF v_holders = 0 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'no_finisher_recorded',
        'expected', v_expected,
        'detail', 'prize is owed to nobody identifiable; needs a human decision');
      CONTINUE;
    END IF;

    IF v_holders > 1 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'duplicate_finishers',
        'holders', v_holders, 'expected', v_expected,
        'detail', 'more than one player recorded in this place (double-pay defect)');
      CONTINUE;
    END IF;

    /* The cap. A top-up settles what the PLACE still owes, not what this
       particular player has yet to receive from it. */
    v_paid_eff := GREATEST(COALESCE(v_paid, 0), COALESCE(v_paid_place, 0));

    IF COALESCE(v_paid_place, 0) > COALESCE(v_paid, 0) + 0.005 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'place_paid_to_a_different_player',
        'user_id', v_holder,
        'paid_to_current_holder', COALESCE(v_paid, 0),
        'paid_at_this_place', v_paid_place,
        'other_recipients', to_jsonb(v_place_others),
        'expected', v_expected,
        'detail', 'this place was settled before the finishing order changed. '
               || 'No automatic top-up: the place is already paid. Paying the '
               || 'current holder as well is a deliberate decision (CLAUDE.md 10.9), '
               || 'made with the earlier payment in view.');
    END IF;

    v_total_paid := v_total_paid + v_paid_eff;
    v_delta := round(v_expected - v_paid_eff, 2);
    v_credited := NULL;
    v_settle := NULL;
    v_settle_paid := 0;

    IF v_delta > 0.005 THEN
      v_total_topup := v_total_topup + v_delta;

      IF p_apply THEN
        IF NOT v_has_record AND COALESCE(v_paid, 0) > 0.005 THEN
          /* THE OBLIGATION LEDGER SEEDS FROM tournament_payouts. This event
             has no payout record at all, yet the holder's wallet shows prize
             credits. Settling from the entitlement would pay the wallet a
             second time - the exact defect this lane exists to end. Report;
             a human writes the record. */
          v_credited := false;
          v_issues := v_issues || jsonb_build_object(
            'place', r.place, 'issue', 'paid_without_payout_record',
            'user_id', v_holder, 'expected', v_expected,
            'wallet_prizes', COALESCE(v_paid, 0), 'wanted', v_delta,
            'detail', 'the wallet was credited but no tournament_payouts row records it; '
                   || 'the obligation ledger cannot see that payment, so nothing was settled. '
                   || 'Backfill the payout record, then re-run.');
        ELSE
          /* ONE SETTLE PATH (Lane A3, 2026-09-02). The place is settled with its
             FULL entitlement; fn_settle_tournament_obligation pays the difference
             against what it already holds as paid, refuses a replay, a second
             user on a paid place, and a payment the prize pool cannot cover
             (escrow_short raises its own critical alert; nothing else may pay). */
          v_settle := public.fn_settle_tournament_obligation(
            p_tournament_id, 'place', r.place, v_holder, v_expected, 'reconcile',
            'Tournament payout reconciliation place ' || r.place::text
              || ' (' || COALESCE(t.name, 'tournament') || ')');
          v_credited    := COALESCE((v_settle->>'ok')::boolean, false);
          v_settle_paid := round(COALESCE((v_settle->>'paid')::numeric, 0), 2);
          v_total_settled := v_total_settled + v_settle_paid;

          IF NOT v_credited THEN
            v_issues := v_issues || jsonb_build_object(
              'place', r.place, 'issue', 'top_up_refused_by_obligation',
              'user_id', v_holder, 'expected', v_expected,
              'already_paid', v_paid_eff, 'wanted', v_delta,
              'refused_reason', v_settle->>'refused_reason',
              'obligation_id', v_settle->>'obligation_id',
              'detail', 'fn_settle_tournament_obligation refused this top-up; '
                     || 'the remaining shortfall needs a human decision');
          END IF;
        END IF;
      END IF;

      v_actions := v_actions || jsonb_build_object(
        'place', r.place, 'user_id', v_holder,
        'expected', v_expected, 'already_paid', v_paid_eff, 'top_up', v_delta,
        'applied', p_apply,
        'settled', CASE WHEN p_apply THEN v_settle_paid ELSE NULL END,
        'obligation_id', v_settle->>'obligation_id');

    ELSIF v_delta < -0.005 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'overpaid', 'user_id', v_holder,
        'expected', v_expected, 'already_paid', v_paid_eff, 'excess', -v_delta,
        'detail', 'reported only; automatic clawback is deliberately not done');
    END IF;

    IF p_apply AND v_expected > 0
       AND COALESCE(v_credited, true)
       AND (v_paid_eff + v_settle_paid)
           >= v_expected - 0.005 THEN
      UPDATE tournament_players tp
         SET prize = v_expected
       WHERE tp.tournament_id = p_tournament_id
         AND tp.user_id = v_holder
         AND tp.position = r.place
         AND COALESCE(tp.prize, 0) = 0;
    END IF;
  END LOOP;

  IF jsonb_array_length(v_issues) > 0 THEN
    v_only_accepted := NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_issues) i
       WHERE i->>'issue' NOT IN ('overpaid', 'no_finisher_recorded',
                                 'place_paid_to_a_different_player')
    );
    v_was_accepted := EXISTS (
      SELECT 1 FROM financial_alerts
       WHERE source = 'fn_tournament_payout_reconcile'
         AND resolved IS TRUE
         AND context->>'tournament_id' = p_tournament_id::text
         AND context ? 'resolution'
    );

    INSERT INTO financial_alerts (severity, source, message, context)
    SELECT 'critical', 'fn_tournament_payout_reconcile',
           'Tournament payout could not be fully reconciled: '
             || COALESCE(t.name, p_tournament_id::text),
           jsonb_build_object('tournament_id', p_tournament_id,
                              'prize_pool', v_pool, 'issues', v_issues)
     WHERE NOT EXISTS (
       SELECT 1 FROM financial_alerts
        WHERE source = 'fn_tournament_payout_reconcile'
          AND resolved IS NOT TRUE
          AND context->>'tournament_id' = p_tournament_id::text)
       AND NOT (round(v_total_topup, 2) = 0 AND v_only_accepted AND v_was_accepted);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'tournament_id', p_tournament_id,
    'name', t.name,
    'prize_pool', v_pool,
    'field_size', v_field,
    'paid_places', jsonb_array_length(v_struct),
    'total_expected', round(v_total_expected, 2),
    'total_paid_to_known_holders', round(v_total_paid, 2),
    'total_top_up', round(v_total_topup, 2),
    'total_settled', round(v_total_settled, 2),
    'applied', p_apply,
    'paid_from', CASE WHEN v_has_record THEN 'payout_record' ELSE 'ledger_fallback' END,
    'money_path', 'fn_settle_tournament_obligation',
    'actions', v_actions,
    'issues', v_issues,
    'clean', (jsonb_array_length(v_actions) = 0 AND jsonb_array_length(v_issues) = 0));
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_tournament_payout_reconcile(uuid,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_reconcile(uuid,boolean) TO service_role;
COMMIT;
