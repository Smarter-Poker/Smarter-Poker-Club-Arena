-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828034458; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
--  A PRIZE OWED TO A PLACE NOBODY REACHED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- computePlacePrize, and this function with it, give the LAST place in the
-- structure whatever is left over, so the paid places sum to the pool to the
-- cent. Nothing trimmed the structure to the size of the FIELD, so when fewer
-- players entered than the structure pays, the residual sat on a place no
-- finisher ever held and never left the house.
--
--   Sunday Midway Major  9 places, 8 entrants  250.00 of a 10,000.00 pool
--   PLO Daily            5 places, 4 entrants   52.50 of a    750.00 pool
--
-- Eight events with a pool in thirty days. Each also left this function
-- reporting `no_finisher_recorded`, which it correctly refuses to resolve on
-- its own, so the criticals accumulated and the money stayed put.
--
-- THE FIX, in both implementations at once. The structure is trimmed to the
-- places the field can actually fill before anything is priced from it. The
-- normalisation that was already here then does the rest: a set of places
-- summing to 97.5 is scaled to 100, so the unfillable place's share is spread
-- proportionally across the players who were really there, and the last
-- remaining place still absorbs the rounding residual.
--
-- The engine side is the same rule in the same shape:
-- server/src/tournament/payoutStructure.ts trimStructureToField, applied inside
-- resolvePayoutStructure so all four payout sites and the stuck-COMPLETING
-- rescue share it. If only one side trimmed, this function would start
-- reporting a false overpayment on every short-field event, which is the
-- "two formulas for one number" defect the residual rule exists to prevent.
--
-- TRIMMING IS THE DIRECTION THAT OVERPAYS: too small a field promotes an
-- earlier place to residual holder. So it is deliberately timid here too. It
-- only trims when the count is at least 1, only when at least one place
-- survives, and only when the trim actually removes something. The count is
-- everyone who ever entered - tournament_players rows are not deleted on
-- elimination, only on an unregistration while registration is open - and this
-- function only ever runs on a COMPLETED event, so the number cannot move.
--
-- AFTER THIS MIGRATION, the two events above:
--
--   Sunday Midway Major  clean=false -> top_up 250.00 to the 8th-place finisher,
--                        issues []    (was: issue no_finisher_recorded place 9)
--   PLO Daily            top_up 52.50 to the 4th-place finisher, issues []
--
-- Nothing is paid by this migration. p_apply defaults to false; the money moves
-- when the repair is run deliberately.

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
  v_pct_sum        numeric;
  v_norm           numeric;
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

  -- SHORT-FIELD RESIDUAL 2026-08-27: a structure cannot pay a place nobody
  -- reached. Trim it to the field before anything is priced from it, so the
  -- residual lands on the last place a player actually held. Everyone who ever
  -- entered, not a live seat count: rows survive elimination and are removed
  -- only by an unregistration while registration is still open, and this
  -- function runs on COMPLETED events, so the number can no longer move.
  SELECT count(*) INTO v_field
    FROM tournament_players tp WHERE tp.tournament_id = p_tournament_id;

  IF COALESCE(v_field, 0) >= 1 THEN
    SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'place')::int), '[]'::jsonb)
      INTO v_trimmed
      FROM jsonb_array_elements(v_struct) e
     WHERE (e->>'place')::int <= v_field;

    -- Only when it removes something and leaves something. A structure that
    -- would trim to nothing is malformed, not short-handed, and pricing it by
    -- an empty set would pay the pool to nobody.
    IF jsonb_array_length(v_trimmed) > 0
       AND jsonb_array_length(v_trimmed) < jsonb_array_length(v_struct) THEN
      v_struct := v_trimmed;
    END IF;
  END IF;

  SELECT max((e->>'place')::int) INTO v_last_place
    FROM jsonb_array_elements(v_struct) e;

  -- Normalise the structure to 100%, exactly as computePlacePrize does in the
  -- engine. It is what spreads a trimmed place's share proportionally across
  -- the players who were there, and it keeps the two implementations from
  -- diverging on a malformed structure and reporting phantom overpayments
  -- against each other.
  SELECT COALESCE(SUM((e->>'percentage')::numeric), 0) INTO v_pct_sum
    FROM jsonb_array_elements(v_struct) e;
  IF v_pct_sum <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'structure_has_no_percentages');
  END IF;
  v_norm := 100.0 / v_pct_sum;

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
      v_expected := round(v_pool * r.pct * v_norm / 100.0, 2);
    END IF;
    v_running := v_running + v_expected;
    v_total_expected := v_total_expected + v_expected;

    -- Who finished in this place?
    -- (array_agg)[1] rather than min(): Postgres has no min(uuid).
    SELECT count(*), (array_agg(tp.user_id ORDER BY tp.user_id))[1]
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

