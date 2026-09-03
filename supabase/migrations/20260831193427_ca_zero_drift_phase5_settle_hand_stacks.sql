-- BACKFILLED 2026-09-03 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831193427; the file committed at the time was a placeholder
-- marker (kept below) that said to export the body. Content is byte-exact to
-- what ran. Do NOT re-apply; it is already live.

-- ZERO-DRIFT PHASE 5 - PER-HAND STACK SETTLEMENT RPC (prod ~19:52 UTC;
-- canonical body in prod schema_migrations - export via
-- scripts/dev/export-applied-migrations.sh)
-- fn_ca_settle_hand_stacks(table, hand, hand_number, deltas jsonb, rake, bbj):
-- the engine syncStacks landing pad. Idempotent on settlement_idempotency_keys
-- (replay returns the stored result; stale in-flight claims may be taken
-- over); conservation-checked (sum(deltas)+rake+bbj = 0 to the cent, exact
-- 2dp, no negative stacks, no ghost seats - else FULL rollback + recorded
-- failure + conservation incident); walks ca_settlements open→final; stacks
-- only (wallets untouched; rake/BBJ still bank via atomic_distribute_rake).
-- Verified by rolled-back probes: happy path, replay, conservation reject,
-- negative-stack reject, ghost-seat reject. Engine adoption guide: doc 06.

-- ═══════════════════════════════════════════════════════════════════════════
-- ZERO-DRIFT PHASE 5 — PER-HAND STACK SETTLEMENT RPC (ENGINE LANDING PAD)
-- ═══════════════════════════════════════════════════════════════════════════
-- The engine's syncStacks writes seat stacks as a multi-step JS money path —
-- the last one (remaining risk #1 in doc 05). This RPC is its landing pad:
-- ONE call settles a hand's stack deltas atomically, or not at all.
--   • Idempotent: claims settlement_idempotency_keys (table_id, hand_id).
--     A replay of a succeeded hand returns the stored result verbatim.
--     A stale in-flight claim (>5 min, already alarmed by quick-reconcile)
--     may be taken over; a fresh one is refused.
--   • Conservation-checked: sum(deltas) + rake + bbj must equal 0 to the
--     cent, every delta exact 2dp, every touched seat must exist and no
--     stack may go negative — else the ENTIRE hand write is rejected,
--     rolled back, recorded on the claim, and (for conservation breaks) an
--     incident is raised. No partial hand can persist, hard-kill included.
--   • State-machined: every settle walks ca_settlements
--     (settlement_type='hand_stacks') open → … → final; failures land in
--     'failed' with error detail and may resume.
--   • Stacks only: wallets are never touched; rake/BBJ still bank through
--     atomic_distribute_rake. The declared rake/bbj here are only part of
--     the conservation equation.
CREATE OR REPLACE FUNCTION public.fn_ca_settle_hand_stacks(
  p_table_id uuid,
  p_hand_id uuid,
  p_hand_number bigint DEFAULT NULL,
  p_deltas jsonb DEFAULT '[]'::jsonb,
  p_rake numeric DEFAULT 0,
  p_bbj numeric DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_claimed integer; v_prior record; v_sum numeric := 0; v_n integer := 0;
  e jsonb; v_uid uuid; v_delta numeric; v_updated integer;
  v_ca_id uuid; v_err text; v_result jsonb;
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'fn_ca_settle_hand_stacks is engine/service only';
  END IF;
  IF p_table_id IS NULL OR p_hand_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'missing_ids');
  END IF;
  IF jsonb_typeof(p_deltas) IS DISTINCT FROM 'array' OR jsonb_array_length(p_deltas) = 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_deltas');
  END IF;

  -- claim (idempotent replay)
  INSERT INTO public.settlement_idempotency_keys
    (table_id, hand_id, status, attempt_count, first_attempt_at, last_attempt_at)
  VALUES (p_table_id, p_hand_id, 'in_flight', 1, now(), now())
  ON CONFLICT (table_id, hand_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    SELECT status, result, last_attempt_at INTO v_prior
      FROM public.settlement_idempotency_keys
     WHERE table_id = p_table_id AND hand_id = p_hand_id FOR UPDATE;
    IF v_prior.status = 'succeeded' THEN
      RETURN COALESCE(v_prior.result, '{}'::jsonb) || jsonb_build_object('replay', true);
    ELSIF v_prior.status = 'in_flight' AND v_prior.last_attempt_at > now() - interval '5 minutes' THEN
      RETURN jsonb_build_object('success', false, 'reason', 'in_flight');
    ELSE
      UPDATE public.settlement_idempotency_keys
         SET status = 'in_flight', attempt_count = attempt_count + 1, last_attempt_at = now(), error = NULL
       WHERE table_id = p_table_id AND hand_id = p_hand_id;
    END IF;
  END IF;

  -- state machine
  INSERT INTO public.ca_settlements (settlement_type, external_ref, state, table_id, hand_id,
                                     idempotency_key)
  VALUES ('hand_stacks', p_table_id::text || ':' || p_hand_id::text, 'open', p_table_id, p_hand_id,
          'hand:' || p_table_id::text || ':' || p_hand_id::text)
  ON CONFLICT (settlement_type, external_ref) DO UPDATE
    SET state = CASE WHEN public.ca_settlements.state = 'failed' THEN 'open'
                     ELSE public.ca_settlements.state END,
        error_detail = NULL
  RETURNING id INTO v_ca_id;

  BEGIN
    UPDATE public.ca_settlements SET state='locked_for_calculation' WHERE id = v_ca_id AND state='open';

    -- validation: exact scale + conservation
    FOR e IN SELECT * FROM jsonb_array_elements(p_deltas) LOOP
      v_delta := round((e->>'delta')::numeric, 2);
      IF v_delta IS DISTINCT FROM (e->>'delta')::numeric THEN
        RAISE EXCEPTION 'delta for % is not exact 2dp: %', e->>'user_id', e->>'delta';
      END IF;
      v_sum := v_sum + v_delta;
      v_n := v_n + 1;
    END LOOP;
    IF round(v_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0), 2) <> 0 THEN
      RAISE EXCEPTION 'conservation violation: deltas %.2f + rake %.2f + bbj %.2f != 0',
        v_sum, COALESCE(p_rake,0), COALESCE(p_bbj,0);
    END IF;
    UPDATE public.ca_settlements SET state='calculated',
      totals = jsonb_build_object('players', v_n, 'net_deltas', v_sum,
                                  'rake', COALESCE(p_rake,0), 'bbj', COALESCE(p_bbj,0))
      WHERE id = v_ca_id AND state='locked_for_calculation';
    UPDATE public.ca_settlements SET state='validated' WHERE id = v_ca_id AND state='calculated';

    -- apply: all seats or none, no stack below zero, seats never deleted
    FOR e IN SELECT * FROM jsonb_array_elements(p_deltas) LOOP
      v_uid := (e->>'user_id')::uuid;
      v_delta := round((e->>'delta')::numeric, 2);
      CONTINUE WHEN v_delta = 0;
      UPDATE public.table_seats ts
         SET stack = round(ts.stack + v_delta, 2)
       WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL
         AND round(ts.stack + v_delta, 2) >= 0;
      GET DIAGNOSTICS v_updated = ROW_COUNT;
      IF v_updated <> 1 THEN
        RAISE EXCEPTION 'seat write failed for % (delta %): seat missing, left, or stack would go negative',
          v_uid, v_delta;
      END IF;
    END LOOP;
    UPDATE public.ca_settlements SET state='ledger_posted' WHERE id = v_ca_id AND state='validated';
    UPDATE public.ca_settlements SET state='post_commit_verified' WHERE id = v_ca_id AND state='ledger_posted';

    v_result := jsonb_build_object('success', true, 'players', v_n,
      'table_id', p_table_id, 'hand_id', p_hand_id, 'hand_number', p_hand_number,
      'rake', COALESCE(p_rake,0), 'bbj', COALESCE(p_bbj,0));

    UPDATE public.settlement_idempotency_keys
       SET status='succeeded', result=v_result, completed_at=now(), last_attempt_at=now()
     WHERE table_id = p_table_id AND hand_id = p_hand_id;
    UPDATE public.ca_settlements SET state='final' WHERE id = v_ca_id AND state='post_commit_verified';

    RETURN v_result;

  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;  -- every stack write above is rolled back here
    UPDATE public.settlement_idempotency_keys
       SET status='failed', error=left(v_err, 500), last_attempt_at=now()
     WHERE table_id = p_table_id AND hand_id = p_hand_id;
    UPDATE public.ca_settlements SET state='failed', error_detail=left(v_err, 2000)
     WHERE id = v_ca_id;
    IF v_err LIKE 'conservation violation%' THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_settle_hand_stacks', 'ledger_imbalance', 'warning',
        'hand-conservation:' || p_table_id::text,
        round(v_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0), 2), 0,
        round(v_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0), 2),
        'settlement', 'table_seats', p_hand_id, NULL, NULL, p_table_id, NULL, p_hand_id,
        v_ca_id::text, NULL, NULL,
        'engine submitted a hand whose stack deltas do not conserve: ' || left(v_err, 200),
        false, jsonb_build_object('hand_id', p_hand_id, 'hand_number', p_hand_number));
    END IF;
    RETURN jsonb_build_object('success', false, 'reason', 'rolled_back', 'error', v_err,
                              'table_id', p_table_id, 'hand_id', p_hand_id);
  END;
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks(uuid, uuid, bigint, jsonb, numeric, numeric)
  FROM PUBLIC, anon, authenticated;

INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note, active)
VALUES ('function', 'fn_ca_settle_hand_stacks', NULL, 'phase 5: per-hand atomic stack settlement RPC', true)
ON CONFLICT DO NOTHING;
INSERT INTO public.ca_money_rpc_registry (proname, notes)
VALUES ('fn_ca_settle_hand_stacks', 'phase 5 engine landing pad: atomic per-hand stack settlement, conservation-checked, idempotent')
ON CONFLICT DO NOTHING;
