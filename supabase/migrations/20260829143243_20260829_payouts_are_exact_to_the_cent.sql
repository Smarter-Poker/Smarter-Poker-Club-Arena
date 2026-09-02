-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829143243; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  PAYOUTS ARE EXACT TO THE CENT (Dan, 2026-08-29, binding)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan: "THIS NEEDS TO BE EXACT AND 100% ACCURATE AT ALL TIMES, THERE CAN NEVER
-- BE 'ROUNDING' IT MUST ALWAYS BE DOWN TO THE CENT."
--
-- THE DEFECT THIS CLOSES. The engine priced places in DOLLARS using binary
-- floats, and a dollar amount with two decimals is not a number a double can
-- hold. Union Morning Classic, pool 513.00, place 8 at 3.5%:
--
--     JS   513 * 3.5 / 100  ->  17.954999999999998  ->  rounds to 17.95
--     SQL  round(513 * 3.5 / 100, 2)                ->  17.96   (exact decimal)
--
-- This function therefore declared place 8 underpaid by a cent and TOPPED IT
-- UP -- while the engine's last place had already absorbed the residual, so
-- the event had paid out exactly 513.00. The top-up made it 513.01. This
-- function created the overpayment it was reporting, on every run of that
-- event, twice a day. Measured across all 39,609 completed events: 79 do not
-- pay their pool exactly, and since 2026-08-24 every single one of them is
-- this cent.
--
-- THE RULE, now identical here and in server/src/tournament/payoutMath.ts:
--
--   * work in integer CENTS and integer BASIS POINTS -- no fraction exists to
--     be rounded away, so the two implementations cannot drift;
--   * each place takes round_half_up(pool_cents * bp / total_bp), and NEVER
--     more than is left;
--   * the last paid place takes what remains.
--
-- Postgres round(numeric) breaks a .5 tie away from zero and JS Math.round
-- breaks it upward; prizes are never negative, so they agree by construction.
--
-- SPENDING THE POOL DOWN is the second half, and it is not pedantry. The old
-- loop priced the last place as `pool - others` and clamped a negative result
-- at zero -- so on any pool smaller than the number of places it is paying,
-- the places summed to MORE than the pool and nothing noticed. Taking
-- LEAST(remaining, share) makes overspending impossible instead of unlikely.
--
-- Everything else in this function -- the satellite skip, the COMPLETED gate,
-- the short-field trim, the debit-aware paid total, the accepted-finding
-- suppression from earlier today -- is unchanged.
--
-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- Restore the previous pricing loop: declare v_norm/v_running again, set
-- v_norm := 100.0 / v_pct_sum, and price with
--   IF r.place = v_last_place THEN v_expected := round(v_pool - v_running, 2);
--   ELSE v_expected := round(v_pool * r.pct * v_norm / 100.0, 2); END IF;
--   v_running := v_running + v_expected;
-- Doing so re-opens the one-cent divergence with the engine.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_tournament_payout_reconcile(
  p_tournament_id uuid,
  p_apply boolean DEFAULT false
)
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
  v_delta          numeric;
  v_holder         uuid;
  v_holders        int;
  v_actions        jsonb := '[]'::jsonb;
  v_issues         jsonb := '[]'::jsonb;
  v_total_expected numeric := 0;
  v_total_paid     numeric := 0;
  v_total_topup    numeric := 0;
  v_only_accepted  boolean;
  v_was_accepted   boolean;
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

  -- SHORT-FIELD RESIDUAL 2026-08-27: a structure cannot pay a place nobody
  -- reached. Trim it to the field before anything is priced from it.
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

  -- Percentages quantised to integer BASIS POINTS, exactly as payoutMath.ts
  -- does with Math.round(pct * 100). Quantising in only one of the two would
  -- reintroduce the drift this migration exists to remove.
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
    SELECT (e->>'place')::int                            AS place,
           round((e->>'percentage')::numeric * 100)       AS bp
      FROM jsonb_array_elements(v_struct) e
     ORDER BY (e->>'place')::int
  LOOP
    IF r.place = v_last_place THEN
      -- The last paid place takes what is left, so the places sum to the pool
      -- to the cent by construction.
      v_cents := GREATEST(v_remaining, 0);
    ELSE
      -- Its share, rounded half up in integer cents -- and never more than is
      -- left, so the pool cannot be overspent.
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

    IF v_holders = 1 THEN
      -- A DEBIT IS NOT A PAYMENT (2026-08-28): signed off `type`, because both
      -- sign conventions exist in wallet_transactions.
      SELECT round(COALESCE(SUM(
               CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount)
                    ELSE wt.amount END
             ), 0), 2) INTO v_paid
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
    -- AN ACCEPTED FINDING STAYS ACCEPTED (2026-08-29). All three conditions
    -- required; a shortfall always alerts.
    v_only_accepted := NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_issues) i
       WHERE i->>'issue' NOT IN ('overpaid', 'no_finisher_recorded')
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
    'actions', v_actions,
    'issues', v_issues,
    'clean', (jsonb_array_length(v_actions) = 0 AND jsonb_array_length(v_issues) = 0));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  TO service_role;

-- ── POST-APPLY ASSERTIONS ────────────────────────────────────────────────
DO $$
DECLARE
  v      jsonb;
  v_tid  uuid;
BEGIN
  -- The event that overpaid by a cent twice a day. Place 8 must now price at
  -- 17.96, which is what the engine pays, so nothing is topped up.
  SELECT id INTO v_tid FROM tournaments
   WHERE name = 'Union Morning Classic (NLH)' AND status = 'COMPLETED'
     AND prize_pool = 513.00
   ORDER BY ended_at DESC LIMIT 1;

  IF v_tid IS NULL THEN
    RAISE NOTICE 'no 513.00 Union Morning Classic to assert against';
    RETURN;
  END IF;

  v := fn_tournament_payout_reconcile(v_tid, false);   -- dry run, moves nothing

  IF round((v->>'total_expected')::numeric, 2) <> round((v->>'prize_pool')::numeric, 2) THEN
    RAISE EXCEPTION 'the places do not sum to the pool: expected % against a pool of %',
      v->>'total_expected', v->>'prize_pool';
  END IF;

  IF round((v->>'total_top_up')::numeric, 2) <> 0 THEN
    RAISE EXCEPTION 'still wants to top up % on the event it was overpaying', v->>'total_top_up';
  END IF;

  RAISE NOTICE 'reconciler now agrees with the engine on %: expected %, top-up %',
    v_tid, v->>'total_expected', v->>'total_top_up';
END $$;
