-- ============================================================================
--  A PLACE IS PAID ONCE, NO MATTER WHO HOLDS IT (2026-09-02)
-- ============================================================================
--  Applied to production 2026-09-02 16:43Z.
--
--  fn_tournament_payout_reconcile owes money PER PLACE and checked what had
--  been paid PER USER. Those agree only while a finishing place never changes
--  hands. When it does -- a force-complete restating the order, a recovery
--  sweep re-deriving ranks, an agent correcting a finish -- the function looks
--  up who holds place N NOW, sees that user has been paid nothing, and pays
--  them the whole place. The player paid earlier keeps theirs. The place is
--  paid twice and the pool is breached.
--
--  Measured before this was written:
--
--    81 places across 49 tournaments paid to two different users
--    21,206.93 chips of excess
--    every credit landed between 2026-08-31 13:37 and 2026-09-02
--
--  Worst single event, "Sunday $200 Deep Stack" (dfae9288): 44,640.00 pool,
--  62,841.60 paid. All nine paying places paid twice -- structure to one
--  player, reconcile to another, the second exactly 2.1379x the first, because
--  the structure ran against a 20,880.00 pool and the reconciler against the
--  full one. Place 1: 6,264.00 to be61d864, then 13,392.00 to 2d48c8ed.
--
--  The hourly applying sweep (cron job 189, fn_tournament_payout_sweep(7, true,
--  150000)) is what kept re-paying, so this was live and bleeding.
--
--  THE FIX. A top-up is capped by the GREATER of what the current holder was
--  paid and what the PLACE was paid to anybody. A place can never be paid more
--  than the structure says it is worth, whoever ends up holding it.
--
--  The case is reported, not absorbed: a new issue,
--  'place_paid_to_a_different_player', names both users and both amounts.
--  Paying the new holder anyway is sometimes right -- that is a decision under
--  CLAUDE.md 10.9, made with the earlier payment in view, never a side effect
--  of an hourly sweep. The issue joins 'overpaid' and 'no_finisher_recorded' in
--  the accepted set so a resolved event stays quiet instead of re-raising.
--
--  NOT CLAWED BACK: the 21,206.93 already out stays with the players who
--  received it (10.9 rule 3). This stops the bleed; it does not reopen the past.
--
--  Everything else in the function is byte-for-byte what it was.
-- ============================================================================

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
  v_actions        jsonb := '[]'::jsonb;
  v_issues         jsonb := '[]'::jsonb;
  v_total_expected numeric := 0;
  v_total_paid     numeric := 0;
  v_total_topup    numeric := 0;
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
        SELECT round(COALESCE(SUM(tpo.amount), 0), 2) INTO v_paid
          FROM public.tournament_payouts tpo
         WHERE tpo.tournament_id = p_tournament_id
           AND tpo.user_id = v_holder
           AND tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                              'late_reg_adjustment', 'clawback',
                              'final_table_deal', 'spin_backpay',
                              'overlay_backpay');

        /* A PLACE IS PAID ONCE, NO MATTER WHO HOLDS IT (2026-09-02).
           What this place has already cost, to ANYBODY. */
        SELECT round(COALESCE(SUM(tpo.amount), 0), 2),
               COALESCE(array_agg(DISTINCT tpo.user_id)
                        FILTER (WHERE tpo.user_id <> v_holder), ARRAY[]::uuid[])
          INTO v_paid_place, v_place_others
          FROM public.tournament_payouts tpo
         WHERE tpo.tournament_id = p_tournament_id
           AND tpo.position = r.place
           AND tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                              'late_reg_adjustment', 'clawback',
                              'final_table_deal', 'spin_backpay',
                              'overlay_backpay');
      ELSE
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

    IF v_delta > 0.005 THEN
      v_actions := v_actions || jsonb_build_object(
        'place', r.place, 'user_id', v_holder,
        'expected', v_expected, 'already_paid', v_paid_eff, 'top_up', v_delta,
        'applied', p_apply);
      v_total_topup := v_total_topup + v_delta;

      IF p_apply THEN
        v_credited := fn_credit_and_log(
          v_holder,
          v_delta,
          'tourney:' || p_tournament_id::text || ':prize:' || v_holder::text
            || ':' || r.place::text || ':reconcile',
          'prize',
          'Tournament payout reconciliation place ' || r.place::text
            || ' (' || COALESCE(t.name, 'tournament') || ')',
          p_tournament_id);

        IF NOT COALESCE(v_credited, false) THEN
          v_issues := v_issues || jsonb_build_object(
            'place', r.place, 'issue', 'top_up_refused_by_idempotency',
            'user_id', v_holder, 'expected', v_expected,
            'already_paid', v_paid_eff, 'wanted', v_delta,
            'detail', 'this place has already been credited under its reconcile key; '
                   || 'the remaining shortfall needs a human decision');
        END IF;
      END IF;

    ELSIF v_delta < -0.005 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'overpaid', 'user_id', v_holder,
        'expected', v_expected, 'already_paid', v_paid_eff, 'excess', -v_delta,
        'detail', 'reported only; automatic clawback is deliberately not done');
    END IF;

    IF p_apply AND v_expected > 0
       AND COALESCE(v_credited, true)
       AND (v_paid_eff + CASE WHEN v_delta > 0.005 THEN v_delta ELSE 0 END)
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
    'applied', p_apply,
    'paid_from', CASE WHEN v_has_record THEN 'payout_record' ELSE 'ledger_fallback' END,
    'actions', v_actions,
    'issues', v_issues,
    'clean', (jsonb_array_length(v_actions) = 0 AND jsonb_array_length(v_issues) = 0));
END;
$function$;

-- ----------------------------------------------------------------------------
--  WHO MAY CALL IT (applied to production 2026-09-02 as its own migration,
--  20260902_the_payout_reconciler_states_who_may_call_it; a no-op there, and
--  that is the point).
--
--  Production already restricts both functions to postgres and service_role,
--  but only as an ACL applied out of band. It was nowhere in the migrations, so
--  a database rebuilt from this repo would create a SECURITY DEFINER function
--  that moves prize money, takes `p_apply` as a parameter, and carries the
--  default PUBLIC EXECUTE. Both are engine-side repair passes; nobody in a
--  browser should ever call either. PUBLIC is named alongside the roles because
--  revoking a role while PUBLIC still holds the grant reads as a fix and does
--  nothing.
-- ----------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer)
  TO service_role;
