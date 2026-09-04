-- ═══════════════════════════════════════════════════════════════════════════
-- A SEAT THAT LEFT DURING THE HAND IS SETTLED, NOT REFUSED (chip standard,
-- 2026-09-04 verification sweep). Companion to 20260904104847.
--
-- In the first 40 minutes of delta mode, 3 cash hands were refused with
-- "seat missing or left": in each, a player asked to leave mid-hand, and the
-- PREVIOUS hand's leave_pending settlement step - still running, because of
-- the barrier defect the engine half of #2958 fixes - cashed the seat out
-- 2 to 11 seconds before the hand ended, at the stack it held BEFORE the
-- hand. Refusing the whole hand then left the winner unpaid in the database
-- and the leaver refunded the blind they had put in the pot.
--
-- Now, in delta mode: the players still seated get their deltas; the leaver's
-- own delta is settled against the club wallet the seat cashed out to - a
-- negative delta (what they bet) is debited, a positive one (what they won)
-- is credited - keyed late_seat_settle:<hand>:<user> so no retry settles it
-- twice, journalled player_wallet <-> table_stack as category settlement,
-- with a chip_transactions row the player can read. A wallet that cannot
-- cover the debit refuses the whole hand as before. Absolute mode (an engine
-- without stack_before) is unchanged: it still refuses.
--
-- The function is re-created whole from its live definition with these
-- additions, so the mirror is the definition.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_ca_settle_hand_stacks_absolute(p_table_id uuid, p_hand_number bigint, p_stacks jsonb DEFAULT '[]'::jsonb, p_rake numeric DEFAULT NULL::numeric, p_bbj numeric DEFAULT NULL::numeric, p_ref text DEFAULT NULL::text, p_inflow numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_hand uuid; v_claimed integer; v_prior record; v_ca_id uuid;
  e jsonb; v_uid uuid; v_new numeric; v_old numeric; v_before numeric; v_target numeric;
  v_delta_sum numeric := 0; v_expected numeric;
  v_n integer := 0; v_updated integer; v_err text; v_result jsonb;
  v_delta_mode boolean;
  v_targets jsonb := '{}'::jsonb;      -- user_id -> stack to write
  v_rebased jsonb := '{}'::jsonb;      -- user_id -> db_before - engine_before (delta mode only)
  v_rebase_rows jsonb := '[]'::jsonb;  -- rows for ca_seat_stack_rebases
  v_rebase_count integer := 0;
  -- 2026-09-04 (verification sweep): a seat that LEFT during the hand
  v_departed jsonb := '[]'::jsonb;   -- [{user_id, delta, club_id}]
  v_dep record; v_dep_club uuid; v_dep_after numeric; v_dep_key text; v_dep_claimed integer;
  -- chip-std Lane F (2026-09-02): tournament conservation (absolute mode)
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

  /* DELTA MODE (chip standard 2026-09-04): the engine says what each stack
     WAS when it dealt and what it IS now; the database applies the difference
     to whatever the row holds. Every element must carry stack_before, or the
     whole call is absolute - a mixed payload would silently erase on the
     seats that lacked it. */
  SELECT bool_and(x ? 'stack_before' AND jsonb_typeof(x -> 'stack_before') = 'number')
    INTO v_delta_mode
    FROM jsonb_array_elements(p_stacks) x;
  v_delta_mode := COALESCE(v_delta_mode, false);

  -- stable hand id from (table, hand number[, ref])
  v_hand := md5('ca-hand:' || p_table_id::text || ':' || p_hand_number::text
                || CASE WHEN p_ref IS NULL OR p_ref = '' THEN '' ELSE ':' || p_ref END)::uuid;

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

    -- lock seats, compute deltas / targets
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
        /* A SEAT THAT LEFT DURING THE HAND (2026-09-04, verification sweep).
           In delta mode the player's own delta is settled against the club
           wallet the seat cashed out to, keyed on hand + user, and the players
           still seated get their deltas as usual. Refusing the whole hand here
           left the winner unpaid in the database and the leaver refunded the
           bet they had put in the pot (the exit cashes out the seat's stack
           as it stood BEFORE the hand). Measured before this: 3 cash hands in
           the first 40 minutes of delta mode, each a mid-hand leave_pending
           cash-out raced by a stale settlement step. Absolute mode still
           refuses: with no stack_before there is no delta to settle. */
        IF v_delta_mode THEN
          v_before := round((e->>'stack_before')::numeric, 2);
          IF v_before IS NULL OR v_before < 0 THEN
            RAISE EXCEPTION 'invalid stack_before for %: %', e->>'user_id', e->>'stack_before';
          END IF;
          SELECT ts.club_id INTO v_dep_club FROM public.table_seats ts
           WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NOT NULL
           ORDER BY ts.left_at DESC LIMIT 1;
          IF v_dep_club IS NULL THEN
            SELECT t.club_id INTO v_dep_club FROM public.tables t WHERE t.id = p_table_id;
          END IF;
          IF v_dep_club IS NULL OR NOT EXISTS (SELECT 1 FROM public.club_members m WHERE m.user_id = v_uid AND m.club_id = v_dep_club) THEN
            RAISE EXCEPTION 'seat missing or left for % and no club wallet resolves for it - hand write rejected whole', v_uid;
          END IF;
          v_delta_sum := v_delta_sum + (v_new - v_before);
          v_departed := v_departed || jsonb_build_array(jsonb_build_object(
            'user_id', v_uid, 'delta', round(v_new - v_before, 2), 'club_id', v_dep_club));
          v_n := v_n + 1;
          CONTINUE;
        END IF;
        RAISE EXCEPTION 'seat missing or left for % - hand write rejected whole', v_uid;
      END IF;
      v_old := COALESCE(v_old, 0);

      IF v_delta_mode THEN
        v_before := round((e->>'stack_before')::numeric, 2);
        IF v_before IS NULL OR v_before < 0 THEN
          RAISE EXCEPTION 'invalid stack_before for %: %', e->>'user_id', e->>'stack_before';
        END IF;
        v_target := round(v_old + (v_new - v_before), 2);
        IF v_target < 0 THEN
          RAISE EXCEPTION 'negative stack for % after applying delta % to the seat''s % (engine dealt from %) - hand write rejected whole',
            v_uid, round(v_new - v_before, 2), v_old, v_before;
        END IF;
        v_delta_sum := v_delta_sum + (v_new - v_before);
        IF round(v_old - v_before, 2) <> 0 THEN
          v_rebased := v_rebased || jsonb_build_object(v_uid::text, round(v_old - v_before, 2));
          v_rebase_rows := v_rebase_rows || jsonb_build_array(jsonb_build_object(
            'user_id', v_uid, 'engine_before', v_before, 'db_before', v_old,
            'engine_after', v_new, 'written', v_target));
          v_rebase_count := v_rebase_count + 1;
        END IF;
      ELSE
        v_target := v_new;
        v_delta_sum := v_delta_sum + (v_new - v_old);
      END IF;
      v_targets := v_targets || jsonb_build_object(v_uid::text, v_target);
      v_n := v_n + 1;
    END LOOP;

    UPDATE public.ca_settlements SET state='calculated',
      totals = jsonb_build_object('players', v_n, 'net_deltas', round(v_delta_sum,2),
                                  'rake', p_rake, 'bbj', p_bbj, 'inflow', p_inflow,
                                  'mode', CASE WHEN v_delta_mode THEN 'delta' ELSE 'absolute' END,
                                  'rebased', v_rebased, 'ref', p_ref, 'departed', v_departed)
      WHERE id = v_ca_id AND state='locked_for_calculation';

    SELECT tb.tournament_id INTO v_tournament_id FROM public.tables tb WHERE tb.id = p_table_id;

    IF v_delta_mode THEN
      /* THE IDENTITY, ON THE ENGINE'S OWN ARITHMETIC: what the seats gained
         is what arrived from a declared pool, less what left as rake and
         jackpot drop. Checked on every table, cash or tournament, on every
         write. A credit that landed on the row is outside the identity by
         construction - it is in v_old, not in the delta - so it is preserved
         rather than "explained". */
      v_expected := COALESCE(p_inflow, 0) - COALESCE(p_rake, 0) - COALESCE(p_bbj, 0);
      IF round(v_delta_sum - v_expected, 2) <> 0 THEN
        RAISE EXCEPTION 'conservation violation: stack deltas % != inflow % - rake % - bbj % (table % hand %) - write refused whole',
          round(v_delta_sum, 2), COALESCE(p_inflow, 0), COALESCE(p_rake, 0), COALESCE(p_bbj, 0),
          p_table_id, p_hand_number::text || COALESCE(':' || p_ref, '');
      END IF;
    ELSE
      -- ═══ TOURNAMENT CHIPS ARE CONSERVED HAND BY HAND (chip-std Lane F, 2026-09-02) ═══
      -- Absolute mode only. A tournament table has no rake and no BBJ drop,
      -- so the named seats must sum, after this write, to exactly what they
      -- summed to before it. A shortfall that exactly matches rebuy /
      -- re-entry / add-on grants landed on the named seats since this
      -- table's previous settlement is the engine having dealt from a stack
      -- that did not yet hold the grant: the grant is re-added to that seat
      -- so the write conserves instead of erasing it. Anything else is
      -- refused whole, with the numbers.
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
          FOR e IN SELECT * FROM jsonb_array_elements(p_stacks) LOOP
            IF v_grants ? (e->>'user_id') THEN
              v_targets := v_targets || jsonb_build_object(e->>'user_id',
                round((v_targets->>(e->>'user_id'))::numeric + (v_grants->>(e->>'user_id'))::numeric, 2));
            END IF;
          END LOOP;
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
    END IF;
    UPDATE public.ca_settlements SET state='validated' WHERE id = v_ca_id AND state='calculated';

    FOR e IN SELECT * FROM jsonb_array_elements(p_stacks) LOOP
      v_uid := (e->>'user_id')::uuid;
      IF NOT (v_targets ? v_uid::text) THEN
        CONTINUE;  -- a departed seat: settled against the wallet below
      END IF;
      v_target := (v_targets->>(v_uid::text))::numeric;
      UPDATE public.table_seats ts SET stack = v_target
       WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL;
      GET DIAGNOSTICS v_updated = ROW_COUNT;
      IF v_updated <> 1 THEN
        /* aaa_skip_noop_update returns NULL for a row that would not change,
           and ROW_COUNT then reads 0. The seat was locked and found above, so
           a zero-row update whose seat already holds the target is the trigger
           doing its job, not a failed write. Before 2026-09-04 this rejected
           8,645 hands an hour - every hand in which one player's stack did not
           move - and each of those was persisted by the engine's unchecked
           per-seat fallback instead. */
        IF NOT EXISTS (SELECT 1 FROM public.table_seats ts
                        WHERE ts.table_id = p_table_id AND ts.user_id = v_uid
                          AND ts.left_at IS NULL AND ts.stack = v_target) THEN
          RAISE EXCEPTION 'seat write failed for % - hand write rejected whole', v_uid;
        END IF;
      END IF;
    END LOOP;
    /* THE LEAVER STILL OWES WHAT THEY BET, AND IS STILL OWED WHAT THEY WON.
       The exit credited the seat's pre-hand stack to the club wallet, so a
       negative delta is chips the wallet holds that the pot (and now the
       winner's seat) also holds: debit the wallet, counterparty the felt.
       A positive delta is a pot they won after leaving: credit it. Keyed on
       hand + user in wallet_credit_idempotency, so a retry of this hand
       settles nothing twice. A wallet that cannot cover the debit refuses
       the whole hand, with the numbers, rather than going negative. */
    FOR v_dep IN SELECT (d->>'user_id')::uuid AS user_id, (d->>'delta')::numeric AS delta, (d->>'club_id')::uuid AS club_id
                   FROM jsonb_array_elements(v_departed) d LOOP
      IF v_dep.delta = 0 THEN CONTINUE; END IF;
      v_dep_key := 'late_seat_settle:' || v_hand::text || ':' || v_dep.user_id::text;
      INSERT INTO public.wallet_credit_idempotency (key, user_id, amount)
      VALUES (v_dep_key, v_dep.user_id, v_dep.delta)
      ON CONFLICT (key) DO NOTHING;
      GET DIAGNOSTICS v_dep_claimed = ROW_COUNT;
      IF v_dep_claimed = 0 THEN CONTINUE; END IF;  -- already settled by an earlier attempt
      PERFORM public.fn_ca_declare_ledger('settlement', 'table_stack', p_table_id, v_ca_id, v_dep_key, NULL);
      UPDATE public.club_members m
         SET chip_balance = COALESCE(m.chip_balance, 0) + v_dep.delta, updated_at = now()
       WHERE m.user_id = v_dep.user_id AND m.club_id = v_dep.club_id
         AND COALESCE(m.chip_balance, 0) + v_dep.delta >= 0
       RETURNING m.chip_balance INTO v_dep_after;
      PERFORM set_config('app.ledger_category', '', true);
      PERFORM set_config('app.ledger_counterparty', '', true);
      PERFORM set_config('app.ledger_counterparty_entity', '', true);
      PERFORM set_config('app.ledger_idempotency_key', '', true);
      IF v_dep_after IS NULL THEN
        RAISE EXCEPTION 'seat missing or left for % and its club wallet cannot cover its delta of % - hand write rejected whole', v_dep.user_id, v_dep.delta;
      END IF;
      INSERT INTO public.chip_transactions (club_id, to_user_id, amount, transaction_type, notes, table_id, balance_after, metadata)
      VALUES (v_dep.club_id, v_dep.user_id, abs(v_dep.delta),
              CASE WHEN v_dep.delta < 0 THEN 'late_seat_debit' ELSE 'late_seat_credit' END,
              CASE WHEN v_dep.delta < 0
                   THEN format('Hand #%s settled after you left the table: %s chips you had bet are taken from the club wallet the seat cashed out to', p_hand_number, abs(v_dep.delta))
                   ELSE format('Hand #%s settled after you left the table: %s chips you won are credited to your club wallet', p_hand_number, v_dep.delta) END,
              p_table_id, v_dep_after, jsonb_build_object('hand_id', v_hand, 'key', v_dep_key, 'delta', v_dep.delta));
    END LOOP;
    UPDATE public.ca_settlements SET state='ledger_posted' WHERE id = v_ca_id AND state='validated';

    IF v_rebase_count > 0 THEN
      INSERT INTO public.ca_seat_stack_rebases
        (settlement_id, table_id, hand_id, hand_number, user_id, engine_before, db_before, engine_after, written)
      SELECT v_ca_id, p_table_id, v_hand, p_hand_number,
             (r->>'user_id')::uuid, (r->>'engine_before')::numeric, (r->>'db_before')::numeric,
             (r->>'engine_after')::numeric, (r->>'written')::numeric
        FROM jsonb_array_elements(v_rebase_rows) r;
    END IF;
    UPDATE public.ca_settlements SET state='post_commit_verified' WHERE id = v_ca_id AND state='ledger_posted';

    v_result := jsonb_build_object('success', true, 'players', v_n,
      'table_id', p_table_id, 'hand_id', v_hand, 'hand_number', p_hand_number,
      'net_deltas', round(v_delta_sum, 2), 'rake', p_rake, 'bbj', p_bbj, 'inflow', p_inflow,
      'mode', CASE WHEN v_delta_mode THEN 'delta' ELSE 'absolute' END,
      'rebased', v_rebased, 'written', v_targets, 'departed', v_departed,
      'conservation_checked', v_delta_mode OR p_rake IS NOT NULL);

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
    IF v_err LIKE 'conservation violation%' OR v_err LIKE 'negative stack%' THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_settle_hand_stacks_absolute', 'ledger_imbalance', 'warning',
        'hand-conservation:' || p_table_id::text,
        round(v_delta_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0) - COALESCE(p_inflow,0), 2), 0,
        round(v_delta_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0) - COALESCE(p_inflow,0), 2),
        'settlement', 'table_seats', v_hand, NULL, NULL, p_table_id, NULL, v_hand,
        v_ca_id::text, NULL, NULL,
        'engine submitted a hand whose stack deltas do not conserve: ' || left(v_err, 200),
        false, jsonb_build_object('hand_number', p_hand_number, 'ref', p_ref,
                                  'mode', CASE WHEN v_delta_mode THEN 'delta' ELSE 'absolute' END));
    END IF;
    RETURN jsonb_build_object('success', false, 'reason', 'rolled_back', 'error', v_err,
                              'table_id', p_table_id, 'hand_number', p_hand_number, 'ref', p_ref);
  END;
END $function$;
