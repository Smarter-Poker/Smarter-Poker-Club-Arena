-- ═══════════════════════════════════════════════════════════════════════════
-- THE FELT STOPS LOSING CHIPS (chip standard, defect 0 of the 2026-09-04
-- handoff): a seat credit the engine's memory never saw is no longer erased
-- by the next hand's stack write, and a standalone club's tournament rake
-- no longer pretends to leave the felt.
--
-- MEASURED (2026-09-04 08:05-09:05 UTC, fn_ca_trial_balance): the felt's
-- balance moved +1,718.20 while its journal said +3,098.73, difference
-- -1,380.53; tournament_liability -487.66; every other account 0.00. That
-- hour is typical - the meter has read -1,300 to -2,700 every hour since
-- 2026-08-31 20:30 UTC.
--
-- Two defects, opposite signs, found by reconciling every same-player pair
-- of consecutive cash hands against the seat credits journalled between
-- them (docs/changelog/2026-09-04-chip-std-felt-erasure.md carries the
-- probes):
--
--   A. ERASED SEAT CREDITS. A mid-hand add-on is debited from the wallet at
--      request time and applied to table_seats.stack by resolve_pending_addon
--      at settlement step 8e. The engine's dealing loop reloads seats from the
--      database BEFORE that step runs (the settlement barrier assigned in
--      handleHandCompleteEvent overwrites the one that included postHandTasks
--      - engine fix in the same PR), so the credit lands on stale objects, the
--      next hand is dealt from the pre-credit stack, and this function then
--      writes that hand's ABSOLUTE result over the credited row. Wallet
--      debited, felt never credited, chips gone. 64 add-ons / 7,685.70 chips
--      in three hours, ~15% of all mid-hand add-ons; 5 more per hour by the
--      same overwrite of a between-hands add-on through the unchecked
--      per-seat fallback the engine ran whenever this function refused.
--
--      And it refused 8,645 times an hour: aaa_skip_noop_update returns NULL
--      for an unchanged stack, ROW_COUNT reads 0, and "seat write failed"
--      rejected the whole hand - so more than a quarter of cash hands were
--      persisted by the unchecked fallback, not by this function.
--
--   B. MIS-DECLARED TOURNAMENT RAKE. fn_settle_tournament_rake declares
--      prize_liability as the source, but for a standalone club it calls
--      credit_club_rake_to_treasury, which ignores the declaration and writes
--      its own row from table_stack. 250 rows / 1,178.96 an hour said the
--      felt paid rake it never paid, masking most of A on the meter and
--      leaving tournament_liability short by the same amount.
--
-- WHAT CHANGES
--
--   1. credit_club_rake_to_treasury honours app.ledger_counterparty and
--      app.ledger_counterparty_entity when the caller set them. Defaults are
--      unchanged, so cash rake still reads table_stack -> club_treasury.
--
--   2. fn_ca_settle_hand_stacks_absolute (same name, superset signature):
--      - DELTA MODE. When every element carries stack_before, the write is
--        old_db_stack + (stack - stack_before), never the absolute value. A
--        credit that landed on the row between the engine's read and its
--        write is preserved by construction, and recorded in
--        ca_seat_stack_rebases so it can be counted. Conservation is asserted
--        on the deltas: sum(delta) = inflow - rake - bbj, for cash AND
--        tournament tables. A negative resulting stack refuses the whole hand.
--      - ABSOLUTE MODE (no stack_before) keeps the previous behaviour for an
--        engine that has not been rebuilt yet, including the tournament grant
--        re-add.
--      - A zero-row UPDATE whose seat already holds the target value is a
--        no-op suppressed by aaa_skip_noop_update, not a failure.
--      - p_ref distinguishes a second write for the same hand (the BBJ payout
--        re-sync) from the first, so it is not swallowed by the replay guard.
--        p_inflow declares chips arriving on the felt from a pool (the BBJ
--        payout) so the identity still holds.
--
--   3. fn_ca_restore_erased_seat_credit: the keyed door that gives an erased
--      credit back to the player's club wallet, issuance_reserve -> player
--      wallet, category refund, one row on the mint register, refusing a
--      replay. fn_ca_find_erased_seat_credits finds them (same-player pair of
--      consecutive cash hands whose felt moved by exactly -rake-bbj while a
--      credit was applied to a named seat between them);
--      fn_ca_restore_erased_seat_credits runs the two together, dry-run by
--      default. The restoration itself is a separate migration with the
--      probe's numbers asserted (CLAUDE.md 10.9 rule 4).
--
-- The engine half (barrier fix, stack_before/rake/bbj on the RPC, no blind
-- fallback) is in the same PR; this migration is safe to apply before it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. credit_club_rake_to_treasury honours a declared counterparty
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.credit_club_rake_to_treasury(p_club_id uuid, p_amount numeric)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_st  text;
  v_msg text;
  v_from_type   text := 'table_stack';
  v_from_entity uuid := NULL;
BEGIN
  IF p_club_id IS NULL OR p_amount IS NULL OR p_amount = 0 THEN
    RETURN;
  END IF;

  /* CHIP STANDARD (2026-09-04): a caller that declared where the rake comes
     from is believed. fn_settle_tournament_rake declares prize_liability +
     the tournament; cash rake declares nothing and keeps the felt. Before
     this, every standalone-club tournament settlement journalled its rake
     as leaving table_stack - 1,178.96 an hour the felt never paid. */
  IF COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), '') <> '' THEN
    v_from_type := current_setting('app.ledger_counterparty', true);
    BEGIN
      v_from_entity := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_from_entity := NULL;
    END;
  END IF;

  PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
  UPDATE public.clubs
     SET chip_treasury = COALESCE(chip_treasury, 0) + p_amount,
         total_rake    = COALESCE(total_rake, 0) + p_amount,
         updated_at    = now()
   WHERE id = p_club_id;
  PERFORM set_config('app.ledger_autoskip_clubs', '0', true);

  /* Rake comes off its declared source and lands in the treasury. amount > 0
     is a CHECK on chip_ledger, so a negative p_amount (a correction) is
     journaled with its sides swapped rather than dropped. Never blocks the
     credit. */
  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, description)
    VALUES (
      COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
      CASE WHEN p_amount > 0 THEN v_from_type    ELSE 'club_treasury' END,
      CASE WHEN p_amount > 0 THEN v_from_entity  ELSE p_club_id       END,
      CASE WHEN p_amount > 0 THEN 'club_treasury' ELSE v_from_type    END,
      CASE WHEN p_amount > 0 THEN p_club_id       ELSE v_from_entity  END,
      abs(p_amount), 'rake', p_club_id,
      'Rake credited to club treasury (credit_club_rake_to_treasury)');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    BEGIN
      INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
      VALUES (p_club_id, NULL, p_amount, v_st,
              'credit_club_rake_to_treasury: ' || v_msg);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The rebase register: every time a hand write found a seat holding more
--    (or less) than the engine dealt from, and preserved the difference.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_seat_stack_rebases (
  id             bigserial PRIMARY KEY,
  settlement_id  uuid,
  table_id       uuid NOT NULL,
  hand_id        uuid NOT NULL,
  hand_number    bigint,
  user_id        uuid NOT NULL,
  engine_before  numeric NOT NULL,
  db_before      numeric NOT NULL,
  engine_after   numeric NOT NULL,
  written        numeric NOT NULL,
  amount         numeric GENERATED ALWAYS AS (db_before - engine_before) STORED,
  created_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.ca_seat_stack_rebases IS
  'One row per seat whose stack, at the moment of a hand write, differed from the stack the engine dealt from. amount > 0 is a credit that landed on the row the engine never saw (a resolved add-on, a horse funding) and was PRESERVED instead of erased; amount < 0 is a debit likewise. Written by fn_ca_settle_hand_stacks_absolute in delta mode (chip standard 2026-09-04).';
CREATE INDEX IF NOT EXISTS idx_ca_seat_stack_rebases_created ON public.ca_seat_stack_rebases (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ca_seat_stack_rebases_table ON public.ca_seat_stack_rebases (table_id, created_at DESC);
ALTER TABLE public.ca_seat_stack_rebases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_seat_stack_rebases FROM anon, authenticated;
GRANT SELECT ON public.ca_seat_stack_rebases TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. fn_ca_settle_hand_stacks_absolute: delta mode, no-op tolerance, p_ref
-- ───────────────────────────────────────────────────────────────────────────
-- The previous signature (p_table_id, p_hand_number, p_stacks, p_rake, p_bbj)
-- is a prefix of the new one, so the running engine's calls resolve to this
-- body unchanged. Postgres cannot add parameters with CREATE OR REPLACE, so
-- the old function is dropped first; the new one is created in the same
-- transaction, and a call arriving in between waits on the lock.
DROP FUNCTION IF EXISTS public.fn_ca_settle_hand_stacks_absolute(uuid, bigint, jsonb, numeric, numeric);

CREATE FUNCTION public.fn_ca_settle_hand_stacks_absolute(
  p_table_id uuid,
  p_hand_number bigint,
  p_stacks jsonb DEFAULT '[]'::jsonb,
  p_rake numeric DEFAULT NULL::numeric,
  p_bbj numeric DEFAULT NULL::numeric,
  p_ref text DEFAULT NULL::text,
  p_inflow numeric DEFAULT NULL::numeric)
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
                                  'rebased', v_rebased, 'ref', p_ref)
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
      'rebased', v_rebased, 'written', v_targets,
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

REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(uuid, bigint, jsonb, numeric, numeric, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(uuid, bigint, jsonb, numeric, numeric, text, numeric) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The restoration door and its detector
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_restore_erased_seat_credit(
  p_key text, p_user_id uuid, p_club_id uuid, p_amount numeric, p_table_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inserted integer; v_after numeric; v_ledger uuid; v_supply numeric; v_label text;
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'fn_ca_restore_erased_seat_credit is operator/service only';
  END IF;
  IF p_key IS NULL OR p_user_id IS NULL OR p_club_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'key, user, club and a positive amount are required';
  END IF;

  -- One restoration per erased credit, ever.
  INSERT INTO public.wallet_credit_idempotency (key, user_id, amount)
  VALUES (p_key, p_user_id, p_amount)
  ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'already_restored', 'key', p_key);
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, p_club_id);

  /* The chips were destroyed by an un-journalled overwrite of the felt (the
     meter recorded that hour as unexplained negative drift). Giving them back
     is issuance, labelled as such: issuance_reserve -> player_wallet, so the
     meter reads a mint with a reason, not a second unexplained move. */
  PERFORM public.fn_ca_declare_ledger('refund', 'issuance_reserve', NULL, NULL, p_key, NULL);
  UPDATE public.club_members
     SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = now()
   WHERE user_id = p_user_id AND club_id = p_club_id
   RETURNING chip_balance INTO v_after;
  IF v_after IS NULL THEN
    RAISE EXCEPTION 'no club wallet for player % in club %', p_user_id, p_club_id;
  END IF;

  INSERT INTO public.chip_transactions (club_id, to_user_id, amount, transaction_type, notes, table_id, balance_after, metadata)
  VALUES (p_club_id, p_user_id, p_amount, 'seat_credit_restored', p_reason, p_table_id, v_after,
          jsonb_build_object('restore_key', p_key, 'source', 'issuance_reserve'));

  SELECT id INTO v_ledger FROM public.chip_ledger
   WHERE idempotency_key = p_key ORDER BY created_at DESC LIMIT 1;
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) + p_amount
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = 'chips';
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text)
    INTO v_label FROM public.profiles p WHERE p.id = p_user_id;
  BEGIN
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount,
       balance_before, balance_after, supply_after, reason, performed_by, performed_by_label, chip_ledger_id)
    VALUES (p_key, 'mint', 'chips', 'player', p_user_id, v_label, p_amount,
            v_after - p_amount, v_after, v_supply, p_reason, NULL, current_user, v_ledger);
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  RETURN jsonb_build_object('restored', true, 'key', p_key, 'user_id', p_user_id,
                            'club_id', p_club_id, 'amount', p_amount, 'balance_after', v_after,
                            'chip_ledger_id', v_ledger);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_restore_erased_seat_credit(text, uuid, uuid, numeric, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_restore_erased_seat_credit(text, uuid, uuid, numeric, uuid, text) TO service_role;

-- The detector. A credit is ERASED when, on a cash table, two consecutive
-- hands share exactly the same players, the felt between them moved by
-- exactly -(rake + bbj) of the later hand (the identity for a hand with no
-- arrivals), and yet a credit was applied to one of those seats between the
-- two hands with no other seat movement on that table in the window. Two
-- sources of credits: table_pending_addons rows (kind addon or rebuy) and
-- between-hands add-on ledger legs that have no pending row.
CREATE OR REPLACE FUNCTION public.fn_ca_find_erased_seat_credits(
  p_since timestamptz, p_until timestamptz DEFAULT now())
 RETURNS TABLE(restore_key text, source text, source_id uuid, table_id uuid, user_id uuid, club_id uuid,
               amount numeric, credited_at timestamptz, prev_hand bigint, next_hand bigint, is_horse boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'fn_ca_find_erased_seat_credits is operator/service only';
  END IF;
  RETURN QUERY
  WITH h AS (
    SELECT hh.id, hh.table_id, hh.hand_number, hh.created_at, hh.rake_amount, COALESCE(hh.bbj_amount, 0) AS bbj,
           (SELECT sum((q->>'stack')::numeric) FROM jsonb_array_elements(hh.players) q) AS felt,
           (SELECT array_agg((q->>'userId')::uuid ORDER BY q->>'userId') FROM jsonb_array_elements(hh.players) q) AS ids
      FROM public.hand_history hh
     WHERE hh.tournament_id IS NULL
       AND hh.created_at > p_since - interval '30 minutes' AND hh.created_at <= p_until + interval '30 minutes'
  ), pairs AS (
    SELECT h.*, lag(h.felt) OVER w AS prev_felt, lag(h.created_at) OVER w AS prev_at,
           lag(h.hand_number) OVER w AS prev_hand_number, (h.ids = lag(h.ids) OVER w) AS same_players
      FROM h WINDOW w AS (PARTITION BY h.table_id ORDER BY h.hand_number)
  ), quiet AS (
    -- a boundary whose felt moved by exactly -(rake+bbj): nothing arrived
    SELECT p.table_id, p.prev_at, p.created_at, p.prev_hand_number, p.hand_number, p.ids
      FROM pairs p
     WHERE p.same_players AND p.prev_felt IS NOT NULL
       AND round(p.felt - p.prev_felt + p.rake_amount + p.bbj, 2) = 0
  ), credits AS (
    SELECT 'pending_addon'::text AS source, pa.id AS source_id, pa.table_id, pa.user_id,
           round(pa.applied_to_stack, 2) AS amount, pa.resolved_at AS credited_at
      FROM public.table_pending_addons pa
     WHERE pa.resolved_at > p_since AND pa.resolved_at <= p_until AND pa.applied_to_stack > 0
    UNION ALL
    SELECT 'addon_leg', l.id, l.to_entity_id, l.from_entity_id, round(l.amount, 2), l.created_at
      FROM public.chip_ledger l
     WHERE l.category = 'addon' AND l.to_type = 'table_stack' AND l.from_type = 'player_wallet'
       AND l.created_at > p_since AND l.created_at <= p_until
       AND NOT EXISTS (SELECT 1 FROM public.table_pending_addons q
                        WHERE q.user_id = l.from_entity_id AND q.table_id = l.to_entity_id
                          AND round(q.amount, 2) = round(l.amount, 2)
                          AND q.created_at BETWEEN l.created_at - interval '5 seconds' AND l.created_at + interval '5 seconds')
  )
  SELECT ('seat_credit_erased:' || c.source || ':' || c.source_id::text) AS restore_key,
         c.source, c.source_id, c.table_id, c.user_id,
         COALESCE((SELECT ts.club_id FROM public.table_seats ts
                    WHERE ts.table_id = c.table_id AND ts.user_id = c.user_id
                    ORDER BY ts.joined_at DESC LIMIT 1),
                  (SELECT t.club_id FROM public.tables t WHERE t.id = c.table_id)) AS club_id,
         c.amount, c.credited_at, q.prev_hand_number::bigint, q.hand_number::bigint,
         COALESCE((SELECT pr.is_horse FROM public.profiles pr WHERE pr.id = c.user_id), false) AS is_horse
    FROM credits c
    JOIN quiet q ON q.table_id = c.table_id AND c.user_id = ANY(q.ids)
                AND c.credited_at > q.prev_at AND c.credited_at <= q.created_at
   WHERE NOT EXISTS (   -- exactly one credit in the window, so the identity attributes it
           SELECT 1 FROM credits c2
            WHERE c2.table_id = c.table_id AND c2.source_id <> c.source_id
              AND c2.credited_at > q.prev_at AND c2.credited_at <= q.created_at)
     AND NOT EXISTS (   -- and no other seat movement on the table between the hands
           SELECT 1 FROM public.chip_ledger l
            WHERE l.created_at > q.prev_at AND l.created_at <= q.created_at
              AND l.category IN ('buyin', 'rebuy', 'horse_funding', 'table_cashout')
              AND (l.to_entity_id = c.table_id OR l.from_entity_id = c.table_id OR l.table_id = c.table_id))
     AND NOT EXISTS (SELECT 1 FROM public.wallet_credit_idempotency k
                      WHERE k.key = 'seat_credit_erased:' || c.source || ':' || c.source_id::text)
   ORDER BY c.credited_at;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_find_erased_seat_credits(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_find_erased_seat_credits(timestamptz, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_restore_erased_seat_credits(
  p_since timestamptz, p_until timestamptz DEFAULT now(), p_dry_run boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_n integer := 0; v_sum numeric := 0; v_horses integer := 0; v_rows jsonb := '[]'::jsonb; v_res jsonb;
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'fn_ca_restore_erased_seat_credits is operator/service only';
  END IF;
  FOR r IN SELECT * FROM public.fn_ca_find_erased_seat_credits(p_since, p_until) LOOP
    IF r.club_id IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT p_dry_run THEN
      v_res := public.fn_ca_restore_erased_seat_credit(
        r.restore_key, r.user_id, r.club_id, r.amount, r.table_id,
        format('Add-on restored to your club wallet: %s chips applied to your seat at %s were erased by the next hand''s stack write (platform defect 2026-08-31 to 2026-09-04, hand %s to %s)',
               r.amount, r.credited_at, r.prev_hand, r.next_hand));
      IF NOT COALESCE((v_res->>'restored')::boolean, false) THEN
        CONTINUE;
      END IF;
    END IF;
    v_n := v_n + 1; v_sum := v_sum + r.amount;
    IF r.is_horse THEN v_horses := v_horses + 1; END IF;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'key', r.restore_key, 'user_id', r.user_id, 'club_id', r.club_id, 'amount', r.amount,
      'table_id', r.table_id, 'credited_at', r.credited_at, 'is_horse', r.is_horse));
  END LOOP;
  RETURN jsonb_build_object('dry_run', p_dry_run, 'since', p_since, 'until', p_until,
                            'count', v_n, 'horses', v_horses, 'total', round(v_sum, 2), 'rows', v_rows);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_restore_erased_seat_credits(timestamptz, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_restore_erased_seat_credits(timestamptz, timestamptz, boolean) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Self-check: the pieces exist and the signature is what the engine calls
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.fn_ca_settle_hand_stacks_absolute(uuid, bigint, jsonb, numeric, numeric, text, numeric)') IS NULL THEN
    RAISE EXCEPTION 'fn_ca_settle_hand_stacks_absolute did not land with the delta-mode signature';
  END IF;
  IF to_regprocedure('public.fn_ca_settle_hand_stacks_absolute(uuid, bigint, jsonb, numeric, numeric)') IS NOT NULL THEN
    RAISE EXCEPTION 'the previous fn_ca_settle_hand_stacks_absolute overload survived - two overloads would make every engine call ambiguous';
  END IF;
  IF to_regclass('public.ca_seat_stack_rebases') IS NULL THEN
    RAISE EXCEPTION 'ca_seat_stack_rebases did not land';
  END IF;
  IF to_regprocedure('public.fn_ca_restore_erased_seat_credit(text, uuid, uuid, numeric, uuid, text)') IS NULL
     OR to_regprocedure('public.fn_ca_find_erased_seat_credits(timestamptz, timestamptz)') IS NULL
     OR to_regprocedure('public.fn_ca_restore_erased_seat_credits(timestamptz, timestamptz, boolean)') IS NULL THEN
    RAISE EXCEPTION 'restoration functions did not land';
  END IF;
  IF position('app.ledger_counterparty' IN pg_get_functiondef('public.credit_club_rake_to_treasury'::regproc)) = 0 THEN
    RAISE EXCEPTION 'credit_club_rake_to_treasury does not honour the declared counterparty';
  END IF;
END $$;
