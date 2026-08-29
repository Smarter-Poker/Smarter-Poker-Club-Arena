-- ═══════════════════════════════════════════════════════════════════════════
--  ONE RECONCILER: EXACT CENTS, A REAL LEDGER ROW, AND THE PRIZE STAMPED
--  (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THIS SUPERSEDES TWO MIGRATIONS WRITTEN THE SAME DAY, AND THAT COLLISION IS
-- THE FIRST THING TO UNDERSTAND.
--
--   20260829133000_payouts_are_exact_to_the_cent.sql
--       made the pricing exact -- integer cents and basis points -- so the
--       engine and this function can never disagree by a cent again.
--   20260829140000_reconciler_stamps_the_prize_it_pays.sql
--       made the function write tournament_players.prize, which it had never
--       done: 833 paid placements displayed as 0 to the player and fed 0 to
--       the POY race.
--
-- Both are right and BOTH REDEFINE THE WHOLE FUNCTION. On a replay they run
-- in version order, so 140000 lands last and silently reverts the exactness
-- fix -- a regression armed and waiting, invisible until a pool divided
-- unevenly again. This migration carries both changes and sorts after both.
--
-- THIRD FIX, and it is a defect I shipped in 133000 myself.
--
--   PERFORM credit_player_wallet(...);      -- returns void, dedupes silently
--   PERFORM log_wallet_transaction(...);    -- runs regardless
--
-- That is exactly the pair 20260822190000_credit_player_wallet_once.sql was
-- written to abolish ("converted a double PAYMENT into a double ENTRY... 95
-- phantom prize rows, 7,446.45 chips"). The idempotency key carries no
-- amount, so a second reconcile of the same place at a HIGHER expected prize
-- -- a late guarantee overlay, a repriced structure -- dedupes the credit to
-- nothing while the log writes the delta anyway. And `v_paid` is computed by
-- SUMMING wallet_transactions, so the next run reads that phantom row as
-- money paid and declares the place settled. The shortfall becomes permanently
-- invisible to the only automated net there is.
--
-- fn_credit_and_log returns boolean and writes the ledger row ONLY when the
-- credit actually moved. When it refuses, that is now reported as an issue
-- rather than recorded as a payment.
--
-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- Re-apply 20260829140000_reconciler_stamps_the_prize_it_pays.sql. Doing so
-- reverts BOTH the exact-cent pricing and the phantom-ledger-row fix.
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
  v_credited       boolean;
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
    v_credited := NULL;

    IF v_delta > 0.005 THEN
      v_actions := v_actions || jsonb_build_object(
        'place', r.place, 'user_id', v_holder,
        'expected', v_expected, 'already_paid', v_paid, 'top_up', v_delta,
        'applied', p_apply);
      v_total_topup := v_total_topup + v_delta;

      IF p_apply THEN
        -- fn_credit_and_log writes the ledger row ONLY if the credit moved.
        -- The bare credit_player_wallet + unconditional log_wallet_transaction
        -- pair wrote a row for a deduped credit, and because v_paid is summed
        -- FROM that ledger, the phantom row then hid the shortfall forever.
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
          -- The key has paid before. Whatever is still owed cannot be settled
          -- under it, so say so instead of recording a payment that did not
          -- happen.
          v_issues := v_issues || jsonb_build_object(
            'place', r.place, 'issue', 'top_up_refused_by_idempotency',
            'user_id', v_holder, 'expected', v_expected,
            'already_paid', v_paid, 'wanted', v_delta,
            'detail', 'this place has already been credited under its reconcile key; '
                   || 'the remaining shortfall needs a human decision');
        END IF;
      END IF;

    ELSIF v_delta < -0.005 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'overpaid', 'user_id', v_holder,
        'expected', v_expected, 'already_paid', v_paid, 'excess', -v_delta,
        'detail', 'reported only; automatic clawback is deliberately not done');
    END IF;

    -- STAMP THE PRIZE THE LEDGER PROVES (from 20260829140000). The column
    -- feeds the result card, tournament history and the POY submission, and
    -- this function never wrote it -- 833 paid placements displayed as 0.
    -- Fills a hole only; the engine's own stamp is never overwritten. Dry runs
    -- stay pure reads. A top-up the idempotency key refused is NOT treated as
    -- paid.
    IF p_apply AND v_expected > 0
       AND COALESCE(v_credited, true)
       AND (v_paid + CASE WHEN v_delta > 0.005 THEN v_delta ELSE 0 END)
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
  v     jsonb;
  v_tid uuid;
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_tournament_payout_reconcile';

  -- All three fixes must be present at once; that is the entire point.
  IF position('v_pool_cents' in v_def) = 0 THEN
    RAISE EXCEPTION 'the exact-cent pricing is missing';
  END IF;
  IF position('fn_credit_and_log' in v_def) = 0 THEN
    RAISE EXCEPTION 'still using the bare credit + unconditional log pair';
  END IF;
  IF position('SET prize = v_expected' in v_def) = 0 THEN
    RAISE EXCEPTION 'no longer stamps tournament_players.prize';
  END IF;

  SELECT id INTO v_tid FROM tournaments
   WHERE name = 'Union Morning Classic (NLH)' AND status = 'COMPLETED'
     AND prize_pool = 513.00
   ORDER BY ended_at DESC LIMIT 1;

  IF v_tid IS NULL THEN RETURN; END IF;

  v := fn_tournament_payout_reconcile(v_tid, false);
  IF round((v->>'total_expected')::numeric, 2) <> round((v->>'prize_pool')::numeric, 2) THEN
    RAISE EXCEPTION 'the places do not sum to the pool: % against %',
      v->>'total_expected', v->>'prize_pool';
  END IF;
  IF round((v->>'total_top_up')::numeric, 2) <> 0 THEN
    RAISE EXCEPTION 'still wants to top up % on the event it was overpaying', v->>'total_top_up';
  END IF;
END $$;
