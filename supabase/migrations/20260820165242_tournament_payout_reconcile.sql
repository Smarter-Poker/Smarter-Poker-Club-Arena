-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820165242 "tournament_payout_reconcile"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1c3f783230e6111eb5891c5ae59ecbd0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_tournament_payout_reconcile(
  p_tournament_id uuid,
  p_apply boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  t                record;
  v_struct         jsonb;
  v_pool           numeric;
  v_last_place     int;
  v_running        numeric := 0;
  v_expected       numeric;
  v_paid           numeric;
  v_delta          numeric;
  v_holder         uuid;
  v_holders        int;
  v_actions        jsonb := '[]'::jsonb;
  v_issues         jsonb := '[]'::jsonb;
  v_total_expected numeric := 0;
  v_total_paid     numeric := 0;
  v_total_topup    numeric := 0;
  r                record;
BEGIN
  SELECT id, prize_pool, payout_structure, status, variant, tournament_type, name
    INTO t
    FROM tournaments WHERE id = p_tournament_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  -- Satellites award seats, not cash (processSatelliteAwards). Reconciling
  -- them against a cash pool would invent prizes that do not exist.
  IF COALESCE(t.variant, '') = 'satellite'
     OR upper(COALESCE(t.tournament_type, '')) = 'SATELLITE' THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'satellite_awards_seats');
  END IF;

  -- Only settle finished events; a running tournament has not yet emitted
  -- the places it still owes, and topping it up early would double-pay.
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

  SELECT max((e->>'place')::int) INTO v_last_place
    FROM jsonb_array_elements(v_struct) e;

  FOR r IN
    SELECT (e->>'place')::int         AS place,
           (e->>'percentage')::numeric AS pct
      FROM jsonb_array_elements(v_struct) e
     ORDER BY (e->>'place')::int
  LOOP
    -- Last place absorbs the residual so the places sum to the pool exactly.
    IF r.place = v_last_place THEN
      v_expected := round(v_pool - v_running, 2);
    ELSE
      v_expected := round(v_pool * r.pct / 100.0, 2);
    END IF;
    v_running := v_running + v_expected;
    v_total_expected := v_total_expected + v_expected;

    -- Who finished in this place?
    SELECT count(*), min(tp.user_id)
      INTO v_holders, v_holder
      FROM tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.position = r.place;

    IF v_holders = 1 THEN
      -- What has this player actually been paid in prize money for this event?
      SELECT round(COALESCE(SUM(wt.amount), 0), 2) INTO v_paid
        FROM wallet_transactions wt
       WHERE wt.related_entity_id = p_tournament_id
         AND wt.category = 'prize'
         AND wt.user_id = v_holder;
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

    v_total_paid := v_total_paid + v_paid;
    v_delta := round(v_expected - v_paid, 2);

    IF v_delta > 0.005 THEN
      v_actions := v_actions || jsonb_build_object(
        'place', r.place, 'user_id', v_holder,
        'expected', v_expected, 'already_paid', v_paid, 'top_up', v_delta,
        'applied', p_apply);
      v_total_topup := v_total_topup + v_delta;

      IF p_apply THEN
        -- Same key format the engine uses, so this can never collide with a
        -- concurrent engine payment for the same place.
        PERFORM credit_player_wallet(
          v_holder, v_delta,
          'tourney:' || p_tournament_id::text || ':prize:' || v_holder::text
            || ':' || r.place::text || ':reconcile');
        PERFORM log_wallet_transaction(
          v_holder, 'PLAYER', v_delta, 'credit', 'prize',
          'Tournament payout reconciliation place ' || r.place::text
            || ' (' || COALESCE(t.name, 'tournament') || ')',
          NULL, NULL, p_tournament_id);
      END IF;

    ELSIF v_delta < -0.005 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'overpaid', 'user_id', v_holder,
        'expected', v_expected, 'already_paid', v_paid, 'excess', -v_delta,
        'detail', 'reported only; automatic clawback is deliberately not done');
    END IF;
  END LOOP;

  IF jsonb_array_length(v_issues) > 0 THEN
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
          AND context->>'tournament_id' = p_tournament_id::text);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'tournament_id', p_tournament_id,
    'name', t.name,
    'prize_pool', v_pool,
    'total_expected', round(v_total_expected, 2),
    'total_paid_to_known_holders', round(v_total_paid, 2),
    'total_top_up', round(v_total_topup, 2),
    'applied', p_apply,
    'actions', v_actions,
    'issues', v_issues,
    'clean', (jsonb_array_length(v_actions) = 0 AND jsonb_array_length(v_issues) = 0));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_payout_sweep(
  p_days int DEFAULT 2,
  p_apply boolean DEFAULT false,
  p_limit int DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  r        record;
  v_res    jsonb;
  v_out    jsonb := '[]'::jsonb;
  v_n      int := 0;
  v_topup  numeric := 0;
BEGIN
  FOR r IN
    SELECT t.id
      FROM tournaments t
     WHERE t.status = 'COMPLETED'
       AND t.updated_at > now() - make_interval(days => GREATEST(p_days, 1))
       AND COALESCE(t.prize_pool, 0) > 0
       AND COALESCE(t.variant, '') <> 'satellite'
     ORDER BY t.updated_at DESC
     LIMIT GREATEST(p_limit, 1)
  LOOP
    v_res := fn_tournament_payout_reconcile(r.id, p_apply);
    IF COALESCE((v_res->>'clean')::boolean, true) = false THEN
      v_out := v_out || v_res;
      v_n := v_n + 1;
      v_topup := v_topup + COALESCE((v_res->>'total_top_up')::numeric, 0);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'days', p_days, 'applied', p_apply,
                            'tournaments_with_findings', v_n,
                            'total_top_up', round(v_topup, 2),
                            'findings', v_out);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_tournament_payout_sweep(int, boolean, int)
  FROM PUBLIC, anon, authenticated;
