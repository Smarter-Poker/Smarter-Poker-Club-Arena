-- Version reserved by scripts/new-migration.mjs.
-- A completed five-minute freeze must not start its clock restoration at :00.
-- Prepare the existing v3 installments during the final 90 seconds. Credit the
-- entire scheduled duration and certify no endpoint before the announced end.
-- Late/failed preparation keeps the existing fail-closed rebase and replay path.
-- No money, seating, freeze predicate, ownership or ACL behavior is relaxed.
-- @live-proof: position('GREATEST(v_now, v_due_at)' in pg_get_functiondef('public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text)'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '8s';
DO $preflight$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text)'::regprocedure
  AND md5(prosrc)='d352182bd881a074848061a9c5820cc6'
  AND proowner='postgres'::regrole AND prosecdef
  AND proconfig=ARRAY['search_path=public, pg_temp','statement_timeout=35s','lock_timeout=32s']
  AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
  RAISE EXCEPTION 'ON_TIME_THAW_PREIMAGE_DRIFT' USING ERRCODE='55000';
 END IF;
 IF public.fn_platform_frozen() OR EXISTS(SELECT 1 FROM public.engine_maintenance_break)
  OR EXISTS(SELECT 1 FROM public.engine_maintenance_thaws WHERE contract_version=3
    AND NOT coalesce((shifted->>'complete')::boolean,false)) THEN
  RAISE EXCEPTION 'ON_TIME_THAW_REQUIRES_QUIESCENT_CUTOVER' USING ERRCODE='55000';
 END IF;
END $preflight$;
CREATE OR REPLACE FUNCTION public.fn_thaw_platform(p_announced_at timestamp with time zone, p_freeze_started timestamp with time zone, p_frozen_seconds numeric, p_ownership_token uuid, p_thawed_by text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '35s'
 SET lock_timeout TO '32s'
AS $function$
DECLARE
  c_contract_version CONSTANT integer := 3;
  c_required_steps CONSTANT text[] := ARRAY[
    'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
    'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
    'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
    'cluster_break_eligible_since','cluster_move_expires_at',
    'reconnect_presence','reconnect_snapshots'
  ];
  v_now timestamptz;
  v_due_at timestamptz;
  v_break public.engine_maintenance_break%ROWTYPE;
  v_expected_start timestamptz;
  v_effective_seconds numeric;
  v_existing public.engine_maintenance_thaws%ROWTYPE;
  v_checkpoint_exists boolean;
  v_result jsonb;
  v_shifted jsonb;
  v_installments integer;
  v_reserve_seconds numeric;
  v_release_target timestamptz;
  v_retry_after_ms integer;
BEGIN
  IF p_announced_at IS NULL OR p_freeze_started IS NULL OR p_ownership_token IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_identity_required'
    );
  END IF;

  PERFORM pg_advisory_xact_lock(530090, 1);
  v_now := clock_timestamp();

  SELECT * INTO v_break
    FROM public.engine_maintenance_break b
   WHERE b.id = true
   FOR UPDATE;

  IF NOT FOUND THEN
    SELECT * INTO v_existing
      FROM public.engine_maintenance_thaws t
     WHERE t.freeze_started_at = p_freeze_started
       AND t.announced_at IS NOT DISTINCT FROM p_announced_at
       AND t.ownership_token = p_ownership_token;
    IF FOUND
       AND COALESCE(v_existing.contract_version, 0) = c_contract_version
       AND COALESCE((v_existing.shifted->>'complete')::boolean, false)
       AND v_existing.shifted ?& c_required_steps THEN
      RETURN jsonb_build_object(
        'ok', true, 'complete', true, 'retryable', false,
        'reason', 'release_receipt_recovered', 'released', true,
        'abandoned', false,
        'freeze_started_at', p_freeze_started,
        'credited_through_at', v_existing.release_target_at,
        'effective_frozen_seconds', v_existing.frozen_seconds,
        'ownership_token', p_ownership_token,
        'shifted', v_existing.shifted
      );
    END IF;
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_row_missing'
    );
  END IF;

  IF v_break.ownership_token <> p_ownership_token THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_ownership_changed'
    );
  END IF;

  v_expected_start := COALESCE(
    v_break.break_started_at,
    v_break.announced_at + INTERVAL '2 minutes'
  );
  IF v_break.announced_at IS DISTINCT FROM p_announced_at
     OR v_expected_start IS DISTINCT FROM p_freeze_started THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_identity_mismatch'
    );
  END IF;

  v_due_at := COALESCE(
    v_break.break_ends_at,
    v_break.announced_at + INTERVAL '7 minutes'
  );
  IF v_now < v_due_at - INTERVAL '90 seconds'
     OR (v_now < v_due_at AND
         (v_break.phase IS DISTINCT FROM 'counting_down' OR v_break.break_started_at IS NULL)) THEN
    v_retry_after_ms := GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (
        CASE WHEN v_break.phase = 'counting_down' AND v_break.break_started_at IS NOT NULL
             THEN v_due_at - INTERVAL '90 seconds' ELSE v_due_at END - v_now
      )) * 1000)::integer
    );
    RETURN jsonb_build_object(
      'ok', true, 'complete', false, 'retryable', true,
      'reason', 'maintenance_break_not_due', 'released', false,
      'retry_after_ms', v_retry_after_ms,
      'freeze_started_at', p_freeze_started,
      'ownership_token', p_ownership_token
    );
  END IF;

  SELECT * INTO v_existing
    FROM public.engine_maintenance_thaws t
   WHERE t.freeze_started_at = p_freeze_started
   FOR UPDATE;
  v_checkpoint_exists := FOUND;

  IF v_checkpoint_exists
     AND v_existing.announced_at IS DISTINCT FROM p_announced_at THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_checkpoint_identity_mismatch'
    );
  END IF;

  -- A replacement process adopts the exact break row under this same lock.
  -- Carry that proven ownership into an in-flight v3 checkpoint so recovery
  -- can continue; the retired token fails against the row before reaching it.
  IF v_checkpoint_exists
     AND v_existing.ownership_token IS DISTINCT FROM p_ownership_token
     AND COALESCE(v_existing.contract_version,0)=c_contract_version THEN
    UPDATE public.engine_maintenance_thaws t
       SET ownership_token=p_ownership_token, thawed_by=p_thawed_by
     WHERE t.freeze_started_at=p_freeze_started
       AND t.announced_at IS NOT DISTINCT FROM p_announced_at
       AND t.ownership_token IS NOT DISTINCT FROM v_existing.ownership_token;
    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'ok', false, 'complete', false, 'retryable', false,
        'reason', 'maintenance_checkpoint_identity_mismatch'
      );
    END IF;
    v_existing.ownership_token := p_ownership_token;
  END IF;

  -- A legacy partial checkpoint has aggregate counts but no row identities.
  -- Inventing row receipts for it could double-shift one clock and omit
  -- another.  The migration asserts a quiescent cutover; fail closed if that
  -- precondition was violated rather than guessing.
  IF v_checkpoint_exists
     AND COALESCE(v_existing.contract_version, 0) <> c_contract_version THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'legacy_inflight_thaw_requires_quiescent_cutover'
    );
  END IF;

  v_effective_seconds := CASE
    WHEN v_checkpoint_exists THEN v_existing.frozen_seconds
    ELSE EXTRACT(EPOCH FROM (GREATEST(v_now, v_due_at) - p_freeze_started))
  END;
  IF v_effective_seconds <= 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'implausible_frozen_seconds'
    );
  END IF;

  -- p_frozen_seconds is retained for rolling-call compatibility and logging.
  -- The database clock sampled after the admission boundary is authoritative.
  INSERT INTO public.engine_maintenance_thaws (
    freeze_started_at, frozen_seconds, shifted, thawed_by,
    announced_at, ownership_token, contract_version,
    release_target_at, release_generation
  ) VALUES (
    p_freeze_started, v_effective_seconds, '{}'::jsonb, p_thawed_by,
    p_announced_at, p_ownership_token, c_contract_version, NULL, 0
  )
  ON CONFLICT (freeze_started_at) DO NOTHING;

  SELECT * INTO v_existing
    FROM public.engine_maintenance_thaws t
   WHERE t.freeze_started_at=p_freeze_started
   FOR UPDATE;
  IF v_existing.announced_at IS DISTINCT FROM p_announced_at
     OR v_existing.ownership_token IS DISTINCT FROM p_ownership_token
     OR v_existing.contract_version <> c_contract_version THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_checkpoint_identity_mismatch'
    );
  END IF;

  -- Stage one keeps the deployed installment worker, but snapshots its exact
  -- UUID targets first.  As each legacy step commits, its row receipts advance
  -- in this same outer transaction to the identical initial duration.
  IF v_existing.release_target_at IS NULL THEN
    IF COALESCE((v_existing.shifted->>'_targets_snapshotted')::boolean, false) = false THEN
      PERFORM public.fn_snapshot_maintenance_thaw_targets(
        p_freeze_started, v_existing.frozen_seconds
      );
    END IF;
    -- The retained checkpoint worker validates its CALL argument against its
    -- historical 900-second ceiling, but reads the authoritative duration from
    -- this v3 ledger row. Pass the largest legacy-valid value; the worker and
    -- the exact per-target suffix both use v_existing.frozen_seconds, so a
    -- long-lived owner is recovered in full without weakening its old public
    -- input guard.
    v_result := public.fn_thaw_platform_checkpointed(
      p_freeze_started,
      LEAST(v_existing.frozen_seconds, 900::numeric),
      p_thawed_by
    );
    IF COALESCE((v_result->>'ok')::boolean, false) = false THEN
      RETURN v_result || jsonb_build_object(
        'complete', false, 'retryable', false, 'released', false,
        'freeze_started_at', p_freeze_started,
        'ownership_token', p_ownership_token
      );
    END IF;
    SELECT t.shifted INTO v_shifted
      FROM public.engine_maintenance_thaws t
     WHERE t.freeze_started_at=p_freeze_started;
    UPDATE public.engine_maintenance_thaw_targets x
       SET credited_seconds=v_existing.frozen_seconds
     WHERE x.freeze_started_at=p_freeze_started
       AND x.credited_seconds<v_existing.frozen_seconds
       AND (
         (x.step <> 'level_started_at' AND v_shifted ? x.step)
         OR (
           x.step='level_started_at'
           AND (
             v_shifted ? 'level_started_at'
             OR (
               v_shifted ? 'level_started_at_cursor'
               AND x.target_id <= (v_shifted->>'level_started_at_cursor')::uuid
             )
           )
         )
       );
    IF NOT COALESCE((v_result->>'complete')::boolean, false)
       OR NOT COALESCE((v_shifted->>'complete')::boolean, false)
       OR NOT (v_shifted ?& c_required_steps) THEN
      RETURN v_result || jsonb_build_object(
        'ok', true, 'complete', false, 'retryable', true,
        'reason', 'thaw_checkpointed', 'released', false, 'abandoned', false,
        'retry_after_ms', 0,
        'freeze_started_at', p_freeze_started,
        'credited_through_at', p_freeze_started
          + make_interval(secs=>v_existing.frozen_seconds),
        'effective_frozen_seconds', v_existing.frozen_seconds,
        'ownership_token', p_ownership_token,
        'shifted', v_shifted
      );
    END IF;

    -- The broad work is known now.  Rebase every exact target to a future
    -- endpoint with enough runway to finish in bounded batches.  If the
    -- estimate is missed a later generation doubles it; no door opens on an
    -- expired estimate.
    -- The runway is the number of tail INSTALLMENTS, not of targets.  Each
    -- fn_credit_maintenance_thaw_targets call credits one batch of EVERY step
    -- (40 level_started_at rows, 200 of any other step) inside its 4-second
    -- budget, so the tail needs as many calls as its slowest step, not one
    -- 40-row call per target.  Charging every target at the slowest batch
    -- size held a finished thaw closed for ~170s every hour (2026-10-02 16:00:
    -- 1,668 targets planned 172s; the 7-call tail finished in 4.2s; play
    -- resumed 16:02:59).  A missed estimate still rebases below with a doubled
    -- runway, so no door opens on an expired estimate.
    SELECT COALESCE(max(s.calls), 0) INTO v_installments
      FROM (
        SELECT CEIL(count(*)::numeric
                    / CASE WHEN x.step='level_started_at' THEN 40 ELSE 200 END
               )::integer AS calls
          FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started
         GROUP BY x.step
      ) s;
    v_reserve_seconds := GREATEST(
      8::numeric,
      4::numeric + v_installments::numeric * 4::numeric
    );
    v_release_target := GREATEST(v_due_at, clock_timestamp()
      + make_interval(secs=>v_reserve_seconds));
    v_effective_seconds := EXTRACT(EPOCH FROM (v_release_target-p_freeze_started));
    UPDATE public.engine_maintenance_thaws t
       SET frozen_seconds=v_effective_seconds,
           release_target_at=v_release_target,
           release_generation=1,
           shifted=t.shifted-'complete',
           thawed_at=clock_timestamp()
     WHERE t.freeze_started_at=p_freeze_started;
    RETURN jsonb_build_object(
      'ok', true, 'complete', false, 'retryable', true,
      'reason', 'release_boundary_planned', 'released', false, 'abandoned', false,
      'retry_after_ms', 0,
      'freeze_started_at', p_freeze_started,
      'credited_through_at', v_release_target,
      'effective_frozen_seconds', v_effective_seconds,
      'ownership_token', p_ownership_token,
      'shifted', v_shifted-'complete'
    );
  END IF;

  -- Stage two advances only each target's uncredited suffix.  No completed
  -- step is ever shifted by the full duration twice.
  v_result := public.fn_credit_maintenance_thaw_targets(
    p_freeze_started, v_existing.frozen_seconds
  );
  IF COALESCE((v_result->>'ok')::boolean, false) = false THEN
    RETURN v_result || jsonb_build_object(
      'complete', false, 'retryable', false, 'released', false,
      'freeze_started_at', p_freeze_started,
      'ownership_token', p_ownership_token
    );
  END IF;
  SELECT * INTO v_existing
    FROM public.engine_maintenance_thaws t
   WHERE t.freeze_started_at=p_freeze_started
   FOR UPDATE;
  v_shifted := v_existing.shifted;
  IF NOT COALESCE((v_result->>'complete')::boolean, false) THEN
    RETURN v_result || jsonb_build_object(
      'ok', true, 'complete', false, 'retryable', true,
      'reason', 'thaw_tail_checkpointed', 'released', false, 'abandoned', false,
      'retry_after_ms', 0,
      'freeze_started_at', p_freeze_started,
      'credited_through_at', v_existing.release_target_at,
      'effective_frozen_seconds', v_existing.frozen_seconds,
      'ownership_token', p_ownership_token,
      'shifted', v_shifted
    );
  END IF;

  v_now := clock_timestamp();
  IF v_now >= v_existing.release_target_at THEN
    SELECT COALESCE(max(s.calls), 0) INTO v_installments
      FROM (
        SELECT CEIL(count(*)::numeric
                    / CASE WHEN x.step='level_started_at' THEN 40 ELSE 200 END
               )::integer AS calls
          FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started
         GROUP BY x.step
      ) s;
    v_reserve_seconds := GREATEST(
      8::numeric,
      (4::numeric + v_installments::numeric * 4::numeric)
        * power(2::numeric, LEAST(v_existing.release_generation, 8))
    );
    v_release_target := v_now + make_interval(secs=>v_reserve_seconds);
    v_effective_seconds := EXTRACT(EPOCH FROM (v_release_target-p_freeze_started));
    UPDATE public.engine_maintenance_thaws t
       SET frozen_seconds=v_effective_seconds,
           release_target_at=v_release_target,
           release_generation=t.release_generation+1,
           shifted=t.shifted-'complete',
           thawed_at=clock_timestamp()
     WHERE t.freeze_started_at=p_freeze_started;
    RETURN jsonb_build_object(
      'ok', true, 'complete', false, 'retryable', true,
      'reason', 'release_boundary_rebased', 'released', false, 'abandoned', false,
      'retry_after_ms', 0,
      'freeze_started_at', p_freeze_started,
      'credited_through_at', v_release_target,
      'effective_frozen_seconds', v_effective_seconds,
      'ownership_token', p_ownership_token,
      'shifted', v_shifted-'complete'
    );
  END IF;

  -- Every target is already credited through the future endpoint.  Commit the
  -- exact row clear now; the certified ledger (consulted by both public freeze
  -- predicates) keeps admission closed until that instant.  This removes the
  -- otherwise-uncreditable DELETE/commit/network tail from the frozen interval.
  UPDATE public.engine_maintenance_thaws t
     SET thawed_at=clock_timestamp()
   WHERE t.freeze_started_at=p_freeze_started;
  DELETE FROM public.engine_maintenance_break b
   WHERE b.id=true
     AND b.announced_at IS NOT DISTINCT FROM p_announced_at
     AND COALESCE(b.break_started_at,b.announced_at+INTERVAL '2 minutes')
         IS NOT DISTINCT FROM p_freeze_started
     AND b.ownership_token=p_ownership_token;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_release_identity_changed'
    );
  END IF;
  RETURN v_result || jsonb_build_object(
    'ok', true, 'complete', true, 'retryable', false,
    'reason', 'thaw_complete_release_scheduled',
    'released', true, 'abandoned', false,
    'freeze_started_at', p_freeze_started,
    'credited_through_at', v_existing.release_target_at,
    'effective_frozen_seconds', v_existing.frozen_seconds,
    'ownership_token', p_ownership_token,
    'shifted', v_shifted
  );
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text) TO service_role;
DO $postflight$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text)'::regprocedure
  AND md5(prosrc)='fcd26a9d89479b005435adda3902c964'
  AND proowner='postgres'::regrole AND prosecdef
  AND proconfig=ARRAY['search_path=public, pg_temp','statement_timeout=35s','lock_timeout=32s']
  AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
  RAISE EXCEPTION 'ON_TIME_THAW_POSTIMAGE_DRIFT' USING ERRCODE='55000';
 END IF;
END $postflight$;
COMMIT;
