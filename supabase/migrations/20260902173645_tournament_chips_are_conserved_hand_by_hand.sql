-- ═══════════════════════════════════════════════════════════════════════════
--  TOURNAMENT CHIPS ARE CONSERVED HAND BY HAND (chip-std Lane F, 2026-09-02)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Tier 2. One transaction, two CREATE OR REPLACE FUNCTION statements, no
-- tables, no data moved. Both bodies were read from pg_proc on 2026-09-02
-- 17:30 UTC immediately before this file was written; everything not named
-- below is byte-identical to production.
--
-- WHAT PRODUCTION SAID (docs/changelog/2026-09-02-chip-std-spin-chips.md):
-- fn_spin_chip_conservation_check reported 114 of 1,206 completed spin/SNG
-- games minting 18,406 tournament chips in 6h. Hand by hand, every one of 23
-- sampled games conserved chips INSIDE every hand (awarded = pot on all of
-- them) and broke BETWEEN two hands across an engine-restart gap, where
-- creditSeatStacks raised every seat below starting_chips back to it. The
-- engine half of the fix (seatStackCredit.ts) is in the same pull request.
-- This is the database half: the settle RPC now refuses to learn a tournament
-- stack total it cannot account for, and the detector no longer looks away
-- from rebuy/add-on games.
--
-- 1. fn_ca_settle_hand_stacks_absolute
--    ADDED, for a table whose tables.tournament_id is set: after the seats are
--    locked and the deltas summed, the new stack sum must equal the persisted
--    stack sum for the named seats (a tournament hand has no rake and no BBJ
--    drop; the engine passes p_rake = NULL, so the strict cash check below
--    never ran for tournaments). A shortfall that EXACTLY matches rebuy /
--    re-entry / add-on grants landed on the named seats since this table's
--    previous settlement is the engine having dealt from a stack that did not
--    yet hold the grant (process_tournament_rebuy does `stack += chips` on a
--    live seat, and the engine writes stacks absolutely); the grant is re-added
--    to that seat inside p_stacks so the write conserves instead of erasing it.
--    Anything else RAISEs 'conservation violation (tournament ...)' with the
--    numbers; the existing handler files the drift incident and returns
--    {success:false, reason:'rolled_back', error:...}, and the engine's
--    syncStacks no longer falls back to per-seat writes on that error.
--    Four variables were added to DECLARE. Nothing else changed.
--
-- 2. fn_spin_chip_conservation_check
--    Rebuy/add-on games are no longer excluded. Their grants are added to the
--    expected total instead: rebuys x COALESCE(rebuy_chips, starting_chips)
--    plus add_on x COALESCE(addon_chips, starting_chips), the exact amounts
--    process_tournament_rebuy grants. The NOT EXISTS on wallet_transactions
--    is gone (it was also one correlated scan per game). The number is no
--    longer a lower bound. Message, dedupe, severity and context keys are
--    unchanged; only the 'detail' string says what is now covered.
--
-- CLAUDE.md 10.5: no is_horse anywhere in this file. A horse's chips are chips.
--
-- Post-apply assertions run at the end of the transaction and abort it on
-- their own assumption violations.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_settle_hand_stacks_absolute(p_table_id uuid, p_hand_number bigint, p_stacks jsonb DEFAULT '[]'::jsonb, p_rake numeric DEFAULT NULL::numeric, p_bbj numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_hand uuid; v_claimed integer; v_prior record; v_ca_id uuid;
  e jsonb; v_uid uuid; v_new numeric; v_old numeric; v_delta_sum numeric := 0;
  v_n integer := 0; v_updated integer; v_err text; v_result jsonb;
  -- chip-std Lane F (2026-09-02): tournament conservation
  v_tournament_id uuid; v_prev_settled timestamptz; v_grants jsonb := '{}'::jsonb;
  v_explained numeric := 0;
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'fn_ca_settle_hand_stacks_absolute is engine/service only';
  END IF;
  IF p_table_id IS NULL OR p_hand_number IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'missing_ids');
  END IF;
  IF jsonb_typeof(p_stacks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_stacks) = 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_stacks');
  END IF;

  -- stable hand id from (table, hand number)
  v_hand := md5('ca-hand:' || p_table_id::text || ':' || p_hand_number::text)::uuid;

  INSERT INTO public.settlement_idempotency_keys
    (table_id, hand_id, status, attempt_count, first_attempt_at, last_attempt_at)
  VALUES (p_table_id, v_hand, 'in_flight', 1, now(), now())
  ON CONFLICT (table_id, hand_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    SELECT status, result, last_attempt_at INTO v_prior
      FROM public.settlement_idempotency_keys
     WHERE table_id = p_table_id AND hand_id = v_hand FOR UPDATE;
    IF v_prior.status = 'succeeded' THEN
      RETURN COALESCE(v_prior.result, '{}'::jsonb) || jsonb_build_object('replay', true);
    ELSIF v_prior.status = 'in_flight' AND v_prior.last_attempt_at > now() - interval '5 minutes' THEN
      RETURN jsonb_build_object('success', false, 'reason', 'in_flight');
    ELSE
      UPDATE public.settlement_idempotency_keys
         SET status = 'in_flight', attempt_count = attempt_count + 1, last_attempt_at = now(), error = NULL
       WHERE table_id = p_table_id AND hand_id = v_hand;
    END IF;
  END IF;

  INSERT INTO public.ca_settlements (settlement_type, external_ref, state, table_id, hand_id, idempotency_key)
  VALUES ('hand_stacks', p_table_id::text || ':' || v_hand::text, 'open', p_table_id, v_hand,
          'hand:' || p_table_id::text || ':' || v_hand::text)
  ON CONFLICT (settlement_type, external_ref) DO UPDATE
    SET state = CASE WHEN public.ca_settlements.state = 'failed' THEN 'open'
                     ELSE public.ca_settlements.state END,
        error_detail = NULL
  RETURNING id INTO v_ca_id;

  BEGIN
    UPDATE public.ca_settlements SET state='locked_for_calculation' WHERE id = v_ca_id AND state='open';

    -- lock seats, compute deltas
    FOR e IN SELECT * FROM jsonb_array_elements(p_stacks) LOOP
      v_uid := (e->>'user_id')::uuid;
      v_new := round((e->>'stack')::numeric, 2);
      IF v_new IS NULL OR v_new < 0 THEN
        RAISE EXCEPTION 'invalid stack for %: %', e->>'user_id', e->>'stack';
      END IF;
      SELECT ts.stack INTO v_old FROM public.table_seats ts
       WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'seat missing or left for % - hand write rejected whole', v_uid;
      END IF;
      v_delta_sum := v_delta_sum + (v_new - COALESCE(v_old, 0));
      v_n := v_n + 1;
    END LOOP;

    UPDATE public.ca_settlements SET state='calculated',
      totals = jsonb_build_object('players', v_n, 'net_deltas', round(v_delta_sum,2),
                                  'rake', p_rake, 'bbj', p_bbj)
      WHERE id = v_ca_id AND state='locked_for_calculation';

    -- ═══ TOURNAMENT CHIPS ARE CONSERVED HAND BY HAND (chip-std Lane F, 2026-09-02) ═══
    -- A tournament table has no rake and no BBJ drop, so the named seats must
    -- sum, after this write, to exactly what they summed to before it. The
    -- engine declares p_rake = NULL for tournaments, so the strict check that
    -- follows never ran for them. A shortfall that exactly matches rebuy /
    -- re-entry / add-on grants landed on the named seats since this table's
    -- previous settlement is the engine having dealt from a stack that did not
    -- yet hold the grant (process_tournament_rebuy does stack += chips on a
    -- live seat): the grant is re-added to that seat so the write conserves
    -- instead of erasing it. Anything else is refused whole, with the numbers.
    SELECT tb.tournament_id INTO v_tournament_id FROM public.tables tb WHERE tb.id = p_table_id;
    IF v_tournament_id IS NOT NULL AND round(v_delta_sum, 2) <> 0 THEN
      SELECT max(k.completed_at) INTO v_prev_settled
        FROM public.settlement_idempotency_keys k
       WHERE k.table_id = p_table_id AND k.status = 'succeeded' AND k.hand_id <> v_hand;
      SELECT COALESCE(jsonb_object_agg(g.user_id::text, g.chips), '{}'::jsonb),
             COALESCE(sum(g.chips), 0)
        INTO v_grants, v_explained
        FROM (
          SELECT w.user_id,
                 sum(CASE WHEN w.category = 'addon'
                          THEN COALESCE(NULLIF(t.addon_chips, 0), t.starting_chips, 0)
                          ELSE COALESCE(NULLIF(t.rebuy_chips, 0), t.starting_chips, 0) END) AS chips
            FROM public.wallet_transactions w
            JOIN public.tournaments t ON t.id = w.related_entity_id
           WHERE w.related_entity_id = v_tournament_id
             AND w.category IN ('rebuy', 'addon')
             AND w.type = 'debit'
             AND w.created_at > COALESCE(v_prev_settled, now() - interval '30 minutes')
             AND w.user_id IN (SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(p_stacks) x)
           GROUP BY w.user_id
        ) g;
      IF v_explained > 0 AND round(v_delta_sum + v_explained, 2) = 0 THEN
        p_stacks := (SELECT jsonb_agg(
                       CASE WHEN v_grants ? (x->>'user_id')
                            THEN x || jsonb_build_object('stack',
                                   round((x->>'stack')::numeric, 2) + (v_grants->>(x->>'user_id'))::numeric)
                            ELSE x END)
                     FROM jsonb_array_elements(p_stacks) x);
        v_delta_sum := 0;
      ELSE
        RAISE EXCEPTION 'conservation violation (tournament %): stack deltas % across % seat(s) of table % hand % (grants since previous settlement: %) - tournament chips must sum to what they summed to before the hand; write refused whole',
          v_tournament_id, round(v_delta_sum, 2), v_n, p_table_id, p_hand_number, v_explained;
      END IF;
    END IF;

    -- strict conservation only when rake is declared
    IF p_rake IS NOT NULL
       AND round(v_delta_sum + p_rake + COALESCE(p_bbj, 0), 2) <> 0 THEN
      RAISE EXCEPTION 'conservation violation: stack deltas %.2f + rake %.2f + bbj %.2f != 0',
        v_delta_sum, p_rake, COALESCE(p_bbj, 0);
    END IF;
    UPDATE public.ca_settlements SET state='validated' WHERE id = v_ca_id AND state='calculated';

    FOR e IN SELECT * FROM jsonb_array_elements(p_stacks) LOOP
      v_uid := (e->>'user_id')::uuid;
      v_new := round((e->>'stack')::numeric, 2);
      UPDATE public.table_seats ts SET stack = v_new
       WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL;
      GET DIAGNOSTICS v_updated = ROW_COUNT;
      IF v_updated <> 1 THEN
        RAISE EXCEPTION 'seat write failed for % - hand write rejected whole', v_uid;
      END IF;
    END LOOP;
    UPDATE public.ca_settlements SET state='ledger_posted' WHERE id = v_ca_id AND state='validated';
    UPDATE public.ca_settlements SET state='post_commit_verified' WHERE id = v_ca_id AND state='ledger_posted';

    v_result := jsonb_build_object('success', true, 'players', v_n,
      'table_id', p_table_id, 'hand_id', v_hand, 'hand_number', p_hand_number,
      'net_deltas', round(v_delta_sum, 2), 'rake', p_rake, 'bbj', p_bbj,
      'conservation_checked', p_rake IS NOT NULL);

    UPDATE public.settlement_idempotency_keys
       SET status='succeeded', result=v_result, completed_at=now(), last_attempt_at=now()
     WHERE table_id = p_table_id AND hand_id = v_hand;
    UPDATE public.ca_settlements SET state='final' WHERE id = v_ca_id AND state='post_commit_verified';
    RETURN v_result;

  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    UPDATE public.settlement_idempotency_keys
       SET status='failed', error=left(v_err, 500), last_attempt_at=now()
     WHERE table_id = p_table_id AND hand_id = v_hand;
    UPDATE public.ca_settlements SET state='failed', error_detail=left(v_err, 2000) WHERE id = v_ca_id;
    IF v_err LIKE 'conservation violation%' THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_settle_hand_stacks_absolute', 'ledger_imbalance', 'warning',
        'hand-conservation:' || p_table_id::text,
        round(v_delta_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0), 2), 0,
        round(v_delta_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0), 2),
        'settlement', 'table_seats', v_hand, NULL, NULL, p_table_id, NULL, v_hand,
        v_ca_id::text, NULL, NULL,
        'engine submitted a hand whose stack deltas do not conserve: ' || left(v_err, 200),
        false, jsonb_build_object('hand_number', p_hand_number));
    END IF;
    RETURN jsonb_build_object('success', false, 'reason', 'rolled_back', 'error', v_err,
                              'table_id', p_table_id, 'hand_number', p_hand_number);
  END;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_spin_chip_conservation_check(p_since_hours integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_hours     integer := GREATEST(COALESCE(p_since_hours, 6), 1);
  v_since     timestamptz := now() - make_interval(hours => v_hours);
  v_checked   integer := 0;
  v_minted    integer := 0;
  v_destroy   integer := 0;
  v_minted_c  numeric := 0;
  v_destroy_c numeric := 0;
  v_worst     numeric := 0;
  v_worst_id  uuid;
  v_ids       uuid[];
  v_lost_write integer := 0;
  v_in_play    integer := 0;
  v_unclear    integer := 0;
  v_verdict   text := 'pass';
  v_severity  text;
  v_message   text;
  v_context   jsonb;
  v_alerts    integer := 0;
BEGIN
  -- Lane F (2026-09-02): expected = every chip the game issued. Each entrant
  -- was issued starting_chips; each rebuy / re-entry issued
  -- COALESCE(rebuy_chips, starting_chips) and each add-on
  -- COALESCE(addon_chips, starting_chips) - the exact grants
  -- process_tournament_rebuy makes. Rebuy/add-on games used to be excluded.
  WITH g AS (
    SELECT t.id,
           (SELECT count(*) * t.starting_chips
                   + COALESCE(sum(GREATEST(COALESCE(tp.rebuys, 0), 0)), 0)
                     * COALESCE(NULLIF(t.rebuy_chips, 0), t.starting_chips)
                   + (count(*) FILTER (WHERE COALESCE(tp.add_on, false)))
                     * COALESCE(NULLIF(t.addon_chips, 0), t.starting_chips)
              FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id) AS expected,
           (SELECT COALESCE(sum(tp.chips), 0) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id) AS actual
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       AND t.variant IN ('spin', 'sng')
       AND COALESCE(t.starting_chips, 0) > 0
       AND t.ended_at >= v_since
  ), d AS (
    SELECT id, actual - expected AS delta FROM g
  )
  SELECT count(*),
         count(*) FILTER (WHERE delta > 0),
         count(*) FILTER (WHERE delta < 0),
         COALESCE(sum(delta) FILTER (WHERE delta > 0), 0),
         COALESCE(sum(-delta) FILTER (WHERE delta < 0), 0),
         COALESCE(max(abs(delta)), 0),
         COALESCE((array_agg(id ORDER BY abs(delta) DESC) FILTER (WHERE delta <> 0))[1:20],
                  ARRAY[]::uuid[])
    INTO v_checked, v_minted, v_destroy, v_minted_c, v_destroy_c, v_worst, v_ids
    FROM d;

  v_worst_id := v_ids[1];

  IF array_length(v_ids, 1) > 0 THEN
    WITH s AS (
      SELECT t.id,
             (SELECT count(*) * t.starting_chips
                     + COALESCE(sum(GREATEST(COALESCE(tp.rebuys, 0), 0)), 0)
                       * COALESCE(NULLIF(t.rebuy_chips, 0), t.starting_chips)
                     + (count(*) FILTER (WHERE COALESCE(tp.add_on, false)))
                       * COALESCE(NULLIF(t.addon_chips, 0), t.starting_chips)
                FROM public.tournament_players tp
               WHERE tp.tournament_id = t.id) AS expected,
             (SELECT COALESCE(sum(tp.chips), 0) FROM public.tournament_players tp
               WHERE tp.tournament_id = t.id) AS actual,
             (SELECT COALESCE(sum((p->>'stack')::numeric), 0)
                FROM public.hand_history h,
                     LATERAL jsonb_array_elements(h.players) p
               WHERE h.id = (SELECT h2.id FROM public.hand_history h2
                              WHERE h2.tournament_id = t.id
                              ORDER BY h2.hand_number DESC LIMIT 1)) AS last_hand
        FROM public.tournaments t
       WHERE t.id = ANY(v_ids)
    )
    SELECT count(*) FILTER (WHERE last_hand = expected AND last_hand <> actual),
           count(*) FILTER (WHERE last_hand = actual AND last_hand <> expected),
           count(*) FILTER (WHERE last_hand NOT IN (expected, actual))
      INTO v_lost_write, v_in_play, v_unclear
      FROM s;
  END IF;

  IF v_minted > 0 OR v_destroy > 0 THEN
    v_verdict  := CASE WHEN v_destroy > 0 THEN 'chips_destroyed' ELSE 'chips_minted' END;
    v_severity := 'critical';
    v_message  := format(
      'Chip conservation broken on %s of %s completed spin/sng game(s) in the '
      'last %sh: %s minted %s chips, %s destroyed %s chips. Worst single game '
      'off by %s. Of the %s sampled: %s lost the final write (the engine ended '
      'on the right total, the record did not), %s had chips move in play (the '
      'engine believed the wrong total too - the serious kind, see issue 2406), '
      '%s unclear. The prize does not depend on the chip count, but the WINNER '
      'does.',
      v_minted + v_destroy, v_checked, v_hours,
      v_minted, round(v_minted_c, 0), v_destroy, round(v_destroy_c, 0),
      round(v_worst, 0),
      COALESCE(array_length(v_ids, 1), 0), v_lost_write, v_in_play, v_unclear);
  END IF;

  v_context := jsonb_build_object(
    'window_hours',    v_hours,
    'variants',        jsonb_build_array('spin', 'sng'),
    'games_checked',   v_checked,
    'minted_games',    v_minted,
    'minted_chips',    round(v_minted_c, 2),
    'destroyed_games', v_destroy,
    'destroyed_chips', round(v_destroy_c, 2),
    'worst_abs_delta', round(v_worst, 2),
    'worst_game',      v_worst_id,
    'sample_games',    to_jsonb(v_ids),
    'sample_size',     COALESCE(array_length(v_ids, 1), 0),
    'lost_final_write', v_lost_write,
    'chips_moved_in_play', v_in_play,
    'classification_unclear', v_unclear,
    'verdict',         v_verdict,
    'detail',          'every completed spin/sng game in the window; rebuy/re-entry/'
                       'add-on grants are counted into the expected total (rebuys x '
                       'rebuy_chips, add_on x addon_chips, each defaulting to '
                       'starting_chips) rather than excluding the game; the '
                       'classification compares each sampled game against the stack '
                       'sum in its own last hand; no money was moved by this check');

  IF v_severity IS NOT NULL THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT v_severity, 'fn_spin_chip_conservation_check', v_message, v_context
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_spin_chip_conservation_check'
          AND fa.resolved IS NOT TRUE
          AND fa.context->>'verdict' = v_verdict);
    IF FOUND THEN v_alerts := 1; END IF;
  END IF;

  RETURN v_context || jsonb_build_object('ok', true, 'alerts_raised', v_alerts);
END;
$function$;

-- ── Post-apply assertions (abort the transaction on any assumption violation) ──
DO $$
DECLARE
  v_src text;
  v_probe jsonb;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_settle_hand_stacks_absolute'
     AND pg_get_function_identity_arguments(p.oid)
         = 'p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric) is missing after replace';
  END IF;
  IF position('conservation violation (tournament' IN v_src) = 0 THEN
    RAISE EXCEPTION 'tournament conservation block did not land in fn_ca_settle_hand_stacks_absolute';
  END IF;
  IF position('seat missing or left for % - hand write rejected whole' IN v_src) = 0
     OR position('conservation violation: stack deltas' IN v_src) = 0
     OR position('fn_ca_raise_drift_incident' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_ca_settle_hand_stacks_absolute lost part of its original body';
  END IF;

  -- the cheap guards still answer without touching a seat
  v_probe := public.fn_ca_settle_hand_stacks_absolute(NULL, NULL, '[]'::jsonb, NULL, NULL);
  IF v_probe->>'reason' IS DISTINCT FROM 'missing_ids' THEN
    RAISE EXCEPTION 'settle RPC no longer refuses missing ids: %', v_probe;
  END IF;

  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_spin_chip_conservation_check';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_spin_chip_conservation_check is missing after replace';
  END IF;
  IF position('addon_refund' IN v_src) > 0 THEN
    RAISE EXCEPTION 'fn_spin_chip_conservation_check still excludes rebuy/add-on games';
  END IF;
  IF position('rebuy_chips' IN v_src) = 0 OR position('addon_chips' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_spin_chip_conservation_check does not count rebuy/add-on grants';
  END IF;
  IF position('is_horse' IN v_src) > 0 THEN
    RAISE EXCEPTION 'fn_spin_chip_conservation_check must not filter horses (CLAUDE.md 10.5)';
  END IF;
END $$;

COMMIT;
