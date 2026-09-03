-- BACKFILLED 2026-09-03 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831195446; the file committed at the time was a placeholder
-- marker (kept below) that said to export the body. Content is byte-exact to
-- what ran. Do NOT re-apply; it is already live.

-- ca_phase5_settle_hand_stacks_absolute (prod 20260831195446). Canonical body lives in prod schema_migrations -
-- replace this marker byte-exact via scripts/dev/export-applied-migrations.sh.
-- Phase 5: absolute-stack variant of the hand settlement RPC - engine syncStacks adopts it with one added argument (see docs 06).

-- ZERO-DRIFT phase 5 addendum: the engine's syncStacks writes ABSOLUTE
-- end-of-hand stacks (it has no per-hand delta bookkeeping), so give it an
-- absolute-stack landing pad it can adopt with a one-line change:
-- fn_ca_settle_hand_stacks_absolute(table, hand_number, stacks jsonb, rake, bbj).
--   • Derives the stable hand id from (table_id, hand_number) — md5-uuid —
--     and claims settlement_idempotency_keys exactly like the delta variant.
--   • Locks every named seat FOR UPDATE, computes the deltas server-side,
--     and when rake+bbj are DECLARED (non-null) checks conservation:
--     sum(new − old) + rake + bbj must be 0 to the cent — else the entire
--     write is rejected and a hand-conservation incident is raised.
--     With rake passed as NULL the write is still atomic, idempotent and
--     all-or-nothing (progressive adoption; strict mode when the engine
--     passes its rake figures).
--   • A seat named in the payload that is missing/left → whole hand rejected.
--     Stacks may not go negative. Seats are never deleted.
--   • Walks ca_settlements open→final; failures land 'failed' and may retry.
CREATE OR REPLACE FUNCTION public.fn_ca_settle_hand_stacks_absolute(
  p_table_id uuid,
  p_hand_number bigint,
  p_stacks jsonb DEFAULT '[]'::jsonb,
  p_rake numeric DEFAULT NULL,
  p_bbj numeric DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_hand uuid; v_claimed integer; v_prior record; v_ca_id uuid;
  e jsonb; v_uid uuid; v_new numeric; v_old numeric; v_delta_sum numeric := 0;
  v_n integer := 0; v_updated integer; v_err text; v_result jsonb;
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
        RAISE EXCEPTION 'seat missing or left for % — hand write rejected whole', v_uid;
      END IF;
      v_delta_sum := v_delta_sum + (v_new - COALESCE(v_old, 0));
      v_n := v_n + 1;
    END LOOP;

    UPDATE public.ca_settlements SET state='calculated',
      totals = jsonb_build_object('players', v_n, 'net_deltas', round(v_delta_sum,2),
                                  'rake', p_rake, 'bbj', p_bbj)
      WHERE id = v_ca_id AND state='locked_for_calculation';

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
        RAISE EXCEPTION 'seat write failed for % — hand write rejected whole', v_uid;
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

REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(uuid, bigint, jsonb, numeric, numeric)
  FROM PUBLIC, anon, authenticated;

INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note, active)
VALUES ('function', 'fn_ca_settle_hand_stacks_absolute', NULL, 'phase 5: absolute-stack hand settlement (engine adoption path)', true)
ON CONFLICT DO NOTHING;
INSERT INTO public.ca_money_rpc_registry (proname, notes)
VALUES ('fn_ca_settle_hand_stacks_absolute', 'phase 5: atomic idempotent absolute-stack hand settlement for engine syncStacks')
ON CONFLICT DO NOTHING;
