-- ═══════════════════════════════════════════════════════════════════════════
--  THE RECONCILER STAMPS THE PRIZE IT PAYS (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Found by the round-9 Heads-Up audit: one completed HU game showed a winner
-- with prize 0 - but the wallet ledger showed the 95.00 credit had landed.
-- Sized in production before writing this: 833 (tournament, player) pairs
-- all-time were PAID prize money in wallet_transactions while every one of
-- their tournament_players rows still reads prize 0 - 525 pairs in the last
-- 48 hours alone, 37,224.98 chips total. No money is missing; the RECORD is.
--
-- Cause: fn_tournament_payout_reconcile measures what a player was paid from
-- the LEDGER (correctly - that is why it never double-pays), tops the player
-- up through credit_player_wallet, and then never writes the one column every
-- display reads. tournament_players.prize feeds the post-game result card,
-- tournament history, and finalizeTournament's POY submission (winnings:
-- player.prize) - so every reconciled placement shows the player a 0 and
-- feeds the POY race a 0, forever.
--
-- Two parts:
--   1. The function now stamps tournament_players.prize = the expected prize
--      for the place, once the ledger shows the holder fully paid - only when
--      p_apply (dry runs stay pure reads), only on a row whose prize is still
--      0 (it fills a hole, never overwrites the engine's own stamp).
--   2. A backfill stamps the rows for every already-paid pair. Pairs with a
--      finishing position get their best-position row; pairs whose rows never
--      received a position get their most recent row, prize only - the
--      backfill does not invent positions. 290 ledger-only pairs (their
--      tournament_players rows were deleted, e.g. by cancellation paths) are
--      left as ledger history; there is no row to stamp.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5): no is_horse filter anywhere here.

-- ── Part 1: the function ────────────────────────────────────────────────────

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

    -- ── STAMP THE PRIZE THE LEDGER PROVES (2026-08-29) ─────────────────────
    -- The money side above is complete for this place: the holder either was
    -- already fully paid, has just been topped up to fully paid, or is
    -- overpaid (in which case they certainly received at least the expected
    -- prize). tournament_players.prize is what the result card, history and
    -- the POY submission read - and this function never wrote it, so 833
    -- reconciled placements displayed as 0 while the wallet held the money.
    -- Fills a hole only (prize still 0); the engine's own stamp is never
    -- overwritten. Dry runs (p_apply false) stay pure reads.
    IF p_apply AND v_expected > 0
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

-- ── Part 1b: nobody in a browser reconciles payouts ─────────────────────────
-- Caught by the pre-push definer-authorization check when this migration
-- re-declared the function: it is SECURITY DEFINER, it writes (wallet credits
-- and now prize stamps), a browser role could execute it, and it never asks
-- who is calling. The only legitimate caller is the server-side payout sweep
-- running as service_role. PUBLIC is named explicitly - revoking a role while
-- PUBLIC still holds EXECUTE reads as a fix and does nothing.

REVOKE ALL ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  TO service_role;

-- ── Part 2: backfill the rows the reconciler already paid ───────────────────
-- The net-paid figure uses the same signed-off-type arithmetic as the
-- function, so a corrective debit or a reversal reduces what gets stamped.
-- One row per (tournament, player): the best (lowest) finishing position when
-- one exists, else the most recent row - prize only, positions are never
-- invented here.

WITH paid AS (
  SELECT wt.related_entity_id AS tid, wt.user_id,
         round(SUM(CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount)
                        ELSE wt.amount END), 2) AS net
    FROM wallet_transactions wt
   WHERE wt.category = 'prize' AND wt.related_entity_id IS NOT NULL
   GROUP BY 1, 2
), unstamped AS (
  SELECT p.tid, p.user_id, p.net
    FROM paid p
   WHERE p.net > 0
     AND EXISTS (SELECT 1 FROM tournaments t WHERE t.id = p.tid)
     AND NOT EXISTS (
       SELECT 1 FROM tournament_players x
        WHERE x.tournament_id = p.tid AND x.user_id = p.user_id
          AND COALESCE(x.prize, 0) > 0)
), target AS (
  SELECT DISTINCT ON (tp.tournament_id, tp.user_id) tp.id, u.net
    FROM tournament_players tp
    JOIN unstamped u ON u.tid = tp.tournament_id AND u.user_id = tp.user_id
   ORDER BY tp.tournament_id, tp.user_id,
            (tp.position IS NULL), tp.position ASC, tp.registered_at DESC
)
UPDATE tournament_players tp
   SET prize = target.net
  FROM target
 WHERE tp.id = target.id;

-- ── Post-apply assertions ───────────────────────────────────────────────────

DO $assert$
DECLARE
  v_left int;
BEGIN
  -- Every paid pair that HAS a row must now be stamped. Payments younger
  -- than five minutes are excluded: a live winner credit can land a moment
  -- before the engine's own stamp, and that in-flight second is not a
  -- backfill failure.
  SELECT count(*) INTO v_left
    FROM (
      SELECT wt.related_entity_id AS tid, wt.user_id,
             round(SUM(CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount)
                            ELSE wt.amount END), 2) AS net
        FROM wallet_transactions wt
       WHERE wt.category = 'prize' AND wt.related_entity_id IS NOT NULL
       GROUP BY 1, 2
      HAVING max(wt.created_at) < now() - interval '5 minutes'
    ) p
   WHERE p.net > 0
     AND EXISTS (SELECT 1 FROM tournaments t WHERE t.id = p.tid)
     AND EXISTS (SELECT 1 FROM tournament_players x
                  WHERE x.tournament_id = p.tid AND x.user_id = p.user_id)
     AND NOT EXISTS (
       SELECT 1 FROM tournament_players x
        WHERE x.tournament_id = p.tid AND x.user_id = p.user_id
          AND COALESCE(x.prize, 0) > 0);
  IF v_left > 0 THEN
    RAISE EXCEPTION 'backfill incomplete: % paid pairs with a row still read prize 0', v_left;
  END IF;
END;
$assert$;
