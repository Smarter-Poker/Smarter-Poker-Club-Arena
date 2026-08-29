-- ═══════════════════════════════════════════════════════════════════════════
--  AN ACCEPTED FINDING STAYS ACCEPTED (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_tournament_payout_reconcile already refuses to file a second alert while
-- one is still OPEN for the same tournament:
--
--     WHERE NOT EXISTS (SELECT 1 FROM financial_alerts
--                        WHERE source = 'fn_tournament_payout_reconcile'
--                          AND resolved IS NOT TRUE
--                          AND context->>'tournament_id' = ...)
--
-- Resolving the alert is what breaks that. The finding does not go away when
-- somebody accepts it -- an overpayment nobody is clawing back is a permanent
-- property of a COMPLETED event -- so the next sweep sees no open alert and
-- files a fresh one. Then that gets resolved, and so on, every 30 minutes,
-- forever.
--
-- Watched live today. 77 alerts were closed at 12:41 under Dan's ruling
-- (20260829124146_close_payout_alerts_dan_accepted_the_overpayments); by 13:07
-- the settler had re-filed 26 of them, every one reporting total_top_up = 0
-- and nothing but `overpaid` and `no_finisher_recorded`. Left alone that
-- buries the next real shortfall inside a day, which is the failure this table
-- exists to prevent.
--
-- MY OWN CHANGE MADE IT WORSE, and that is worth saying plainly.
-- 20260829125035_payout_sweep_window_means_finished_not_created fixed the
-- sweep's window so the deep pass now genuinely reaches old events. That is
-- the fix working -- and it means every historical accepted overpayment is
-- re-examined twice a day instead of never.
--
-- So: an accepted finding is not re-filed, on three conditions, all required.
--
--   1. NOTHING IS OWED. `v_total_topup = 0`. A shortfall is the whole point of
--      the table and always alerts, whatever anybody accepted before.
--   2. EVERY CURRENT ISSUE IS OF A CLASS A HUMAN CAN ONLY ACCEPT --
--      `overpaid` (the reconciler deliberately never claws back) and
--      `no_finisher_recorded` (the prize is owed to nobody identifiable).
--      A `duplicate_finishers` finding is a live double-pay defect and still
--      alerts even on an event with an accepted history.
--   3. A HUMAN HAS ACTUALLY ACCEPTED THIS EVENT -- a resolved alert for this
--      tournament carrying a `resolution` key. Nothing is silenced that was
--      not deliberately looked at.
--
-- What this deliberately does NOT do is stop resolving from working. Close an
-- alert without stamping a resolution and it will be filed again next sweep,
-- exactly as before.
--
-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- Restore the previous body by deleting `v_only_accepted`, `v_was_accepted`,
-- their two assignments, and the trailing
--     AND NOT (round(v_total_topup, 2) = 0 AND v_only_accepted AND v_was_accepted)
-- from the INSERT's WHERE clause. Nothing else in the function changed.
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
      --
      -- A DEBIT IS NOT A PAYMENT (2026-08-28). This summed `amount` and never
      -- looked at `type`, so a corrective debit counted as a second payment:
      -- it invented overpayments on repriced events AND, silently, masked
      -- genuine shortfalls by making a refunded player look paid.
      --
      -- Signed off `type` rather than off the sign of `amount`, because both
      -- conventions exist in this table: the 2026-08-28 reprice wrote POSITIVE
      -- amounts with type='debit', the 2026-08-15 reversal wrote a NEGATIVE
      -- one. Negating the absolute value is right for both.
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
    -- ── AN ACCEPTED FINDING STAYS ACCEPTED (2026-08-29) ───────────────────
    -- See the header. All three conditions are required, and the first --
    -- nothing owed -- is the one that keeps a shortfall loud.
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

-- ── Close the ones that were already re-filed under Dan's ruling ──────────
DO $$
DECLARE
  v_closed int;
  v_before int;
BEGIN
  SELECT count(*) INTO v_before FROM financial_alerts
   WHERE source = 'fn_tournament_payout_reconcile' AND resolved = false;

  WITH candidates AS (
    SELECT a.id,
           coalesce((fn_tournament_payout_reconcile((a.context->>'tournament_id')::uuid, false)->>'total_top_up')::numeric, 0) AS owed
      FROM financial_alerts a
     WHERE a.source = 'fn_tournament_payout_reconcile'
       AND a.resolved = false
       AND a.context ? 'tournament_id'
  ), settled AS (
    UPDATE financial_alerts a
       SET resolved = true,
           resolved_at = now(),
           context = a.context || jsonb_build_object(
             'resolution', 'accepted_by_dan_2026_08_29',
             'resolution_detail',
               're-filed after the 12:41 close because a resolved finding was not suppressed; '
               'the reconciler no longer re-files an accepted finding that owes nothing.')
      FROM candidates c
     WHERE a.id = c.id AND c.owed = 0
    RETURNING a.id
  )
  SELECT count(*) INTO v_closed FROM settled;

  RAISE NOTICE 're-filed alerts: % open, % closed', v_before, v_closed;
END $$;

-- ── POST-APPLY ASSERTION ─────────────────────────────────────────────────
DO $$
DECLARE
  v_tid  uuid;
  v_open int;
BEGIN
  -- Take an event that was just accepted and re-ask it. It must NOT file a
  -- new alert. Dry run only -- this function moves money when p_apply is true.
  SELECT (context->>'tournament_id')::uuid INTO v_tid
    FROM financial_alerts
   WHERE source = 'fn_tournament_payout_reconcile'
     AND resolved IS TRUE AND context ? 'resolution'
     AND jsonb_array_length(coalesce(context->'issues', '[]'::jsonb)) > 0
   ORDER BY resolved_at DESC LIMIT 1;

  IF v_tid IS NULL THEN
    RAISE NOTICE 'no accepted alert to test against; skipping the suppression assertion';
    RETURN;
  END IF;

  PERFORM fn_tournament_payout_reconcile(v_tid, false);

  SELECT count(*) INTO v_open FROM financial_alerts
   WHERE source = 'fn_tournament_payout_reconcile'
     AND resolved = false
     AND context->>'tournament_id' = v_tid::text;

  IF v_open > 0 THEN
    RAISE EXCEPTION 'an accepted finding was re-filed for % -- suppression is not working', v_tid;
  END IF;

  RAISE NOTICE 'suppression verified against %', v_tid;
END $$;

-- ── WHO MAY CALL THIS (2026-08-29) ───────────────────────────────────────
-- Caught by .husky/pre-push check-definer-authorization, and it is right to
-- ask. This function is SECURITY DEFINER, it MOVES MONEY when p_apply is
-- true, and it derives the actor from nothing -- no auth.uid(), no
-- auth.role(). If a browser role could execute it, any signed-in player could
-- point it at any tournament and make it pay.
--
-- Production is already safe: the live ACL is
-- {postgres=X/postgres,service_role=X/postgres}, so no browser role holds
-- EXECUTE today. But CREATE OR REPLACE leaves ACLs alone, which means this
-- file REPLAYED ON A FRESH DATABASE would create the function with the
-- default PUBLIC EXECUTE and quietly open exactly that hole. A migration has
-- to be true on an empty database, not only on this one.
--
-- Nobody in a browser should call a reconciliation pass. Its only caller is
-- RakebackSettlerService on the engine, which holds the service role.
-- PUBLIC is named as well as the roles: revoking anon and authenticated while
-- PUBLIC still holds EXECUTE reads as a fix and does nothing.
REVOKE ALL ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  TO service_role;

-- Same reasoning, same file, because the sweep is the loop around it and
-- carries the same p_apply.
REVOKE ALL ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer)
  TO service_role;

DO $$
DECLARE v_acl text;
BEGIN
  SELECT p.proacl::text INTO v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_tournament_payout_reconcile';

  IF v_acl IS NULL OR v_acl ILIKE '%anon=%' OR v_acl ILIKE '%authenticated=%' THEN
    RAISE EXCEPTION 'a browser role can still execute fn_tournament_payout_reconcile: %', v_acl;
  END IF;
  RAISE NOTICE 'payout reconcile ACL: %', v_acl;
END $$;
