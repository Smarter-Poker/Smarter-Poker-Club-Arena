-- Owner 2026-10-20: daily 04:00 Chicago global maintenance, hourly MTT breaks.
-- Observation follows actual daily/emergency breaks, never invents 23 missing
-- global freezes a day. Backward compatible with a serving hourly predecessor.
-- @live-proof: (SELECT position('America/Chicago' in pg_get_functiondef('public.fn_ca_record_break_scorecard(timestamptz)'::regprocedure)) > 0)
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DO $preimage$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_record_break_scorecard(timestamptz)'::regprocedure) <> '00c4e6cb5cba2a4550e332c1f7d33746' THEN
    RAISE EXCEPTION 'maintenance scorecard preimage changed; requalify';
  END IF;
END;
$preimage$;
CREATE OR REPLACE FUNCTION public.fn_ca_record_break_scorecard(
  p_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS ca_break_scorecards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_end   TIMESTAMPTZ := p_end;
  v_start TIMESTAMPTZ;
  v_observed_at TIMESTAMPTZ := now();
  -- The window actually measured. Equal to [v_start, v_end) only when no
  -- break log row can be found.
  v_meas_start TIMESTAMPTZ;
  v_meas_end   TIMESTAMPTZ;
  v_brk   RECORD;
  v_hands INTEGER; v_wtabs INTEGER;
  v_thaw  RECORD; v_kill INTEGER; v_base INTEGER; v_rec INTEGER;
  v_ship  RECORD; v_pre NUMERIC; v_post NUMERIC; v_conserved BOOLEAN; v_delta NUMERIC;
  v_verdict TEXT; v_row public.ca_break_scorecards; m INTEGER;
  v_early_s NUMERIC; v_late_start_s NUMERIC; v_covered BOOLEAN; v_reasons TEXT[] := '{}';
  -- A break that never started, and what the engine said about it. Scalars
  -- rather than a RECORD on purpose: a record that is only ever SELECTed INTO
  -- inside an IF is "not assigned yet" on every hour that takes the other
  -- branch, and the INSERT below reads these on every hour.
  v_never_started BOOLEAN;
  v_fault_stage TEXT; v_fault_outcome TEXT; v_fault_error TEXT;
  -- The tables recovery is measured over: dealing before the break, still open.
  v_base_ids UUID[];
  c_max_hands CONSTANT INTEGER := 50;
  -- How far the break may miss its :55 -> :00 shape before that is a finding.
  -- The observed healthy breaks start at :55:0x and end at :00:0x-:00:20, so a
  -- 30-second allowance is generous against measured behaviour and still
  -- catches the 71-second early resume that prompted this.
  c_edge_tolerance_s CONSTANT NUMERIC := 30;
BEGIN
  -- No global break was due: continuous cash play is healthy, not a failed thaw.
  IF v_end IS NULL THEN
  -- DAILY_OBSERVATION_SELECTION_BEGIN
  SELECT COALESCE(
    (SELECT b.break_started_at + interval '5 minutes'
       FROM public.engine_maintenance_break_log b
      WHERE b.break_ended_at IS NOT NULL
        AND b.break_started_at + interval '5 minutes' <= v_observed_at
        AND b.break_started_at + interval '5 minutes' > v_observed_at - interval '1 hour'
      ORDER BY b.break_started_at DESC LIMIT 1),
    (SELECT expected_end FROM (
      SELECT (date_trunc('day', v_observed_at AT TIME ZONE 'America/Chicago')
               + interval '4 hours 5 minutes') AT TIME ZONE 'America/Chicago' AS expected_end
    ) d WHERE expected_end <= v_observed_at AND expected_end > v_observed_at - interval '1 hour')
  ) INTO v_end;
  -- DAILY_OBSERVATION_SELECTION_END
  END IF;
  IF v_end IS NULL THEN RETURN NULL; END IF;
  v_start := v_end - interval '5 minutes';
  -- THE BREAK THAT ACTUALLY RAN. Read first, because it defines the window
  -- everything else is measured over.
  SELECT break_started_at, break_ended_at, unparked_at_countdown, peak_unparked,
         ready_for_restart_at
    INTO v_brk
    FROM public.engine_maintenance_break_log
   WHERE break_started_at BETWEEN v_start - interval '3 min' AND v_start + interval '3 min'
   ORDER BY recorded_at DESC LIMIT 1;

  IF v_brk.break_started_at IS NOT NULL AND v_brk.break_ended_at IS NOT NULL THEN
    v_meas_start := v_brk.break_started_at;
    v_meas_end   := v_brk.break_ended_at;
    -- Seconds the break finished BEFORE the hour it was counting down to.
    v_early_s := GREATEST(0, EXTRACT(EPOCH FROM (v_end - v_brk.break_ended_at)));
    -- Seconds the break started AFTER :55.
    v_late_start_s := GREATEST(0, EXTRACT(EPOCH FROM (v_brk.break_started_at - v_start)));
    v_covered := (v_early_s <= c_edge_tolerance_s AND v_late_start_s <= c_edge_tolerance_s);
  ELSE
    v_meas_start := v_start;
    v_meas_end   := v_end;
    v_covered := NULL;  -- unknown, not false: we could not find the break
  END IF;

  -- A BREAK THAT NEVER STARTED (correction c). No break-log row means no
  -- engine ran a break for this hour. The engine records why against the :53
  -- announcement, which is v_start - 2 min; [:52, :55] tolerates a clock a
  -- minute out either side. The newest fault wins, because a restarted engine
  -- that also fails to declare the break adds its row after the first one's.
  v_never_started := (v_brk.break_started_at IS NULL);
  IF v_never_started THEN
    SELECT f.stage, f.outcome, f.error
      INTO v_fault_stage, v_fault_outcome, v_fault_error
      FROM public.engine_maintenance_break_faults f
     WHERE f.announced_at BETWEEN v_start - interval '3 min' AND v_start
     ORDER BY f.recorded_at DESC
     LIMIT 1;
  END IF;

  SELECT count(*), count(DISTINCT table_id) INTO v_hands, v_wtabs
    FROM public.hand_history
   WHERE created_at >= v_meas_start AND created_at < v_meas_end;

  SELECT frozen_seconds, thawed_at INTO v_thaw
    FROM public.engine_maintenance_thaws
   WHERE freeze_started_at BETWEEN v_start - interval '3 min' AND v_start + interval '3 min'
   ORDER BY thawed_at DESC LIMIT 1;

  SELECT count(*) INTO v_kill FROM public.engine_recovery_events
   WHERE event = 'watchdog_kill_rebuild'
     AND event_class = 'automatic_recovery'
     AND created_at >= v_end AND created_at < v_end + interval '5 min';

  -- RECOVERY, OVER THE TABLES THAT CAN COME BACK (correction d). The base is
  -- every table that dealt at :48-:53 and is still open; a tournament table
  -- that finished during the break is closed and will never deal again, and
  -- counting it made every hour with a tournament ending read as a slow
  -- recovery. Recovery is the first minute by which 80% of THOSE SAME tables
  -- have dealt a hand after :00. NULL when there was nothing to measure or
  -- the fleet never got there inside ten minutes: unmeasured, not failed.
  SELECT array_agg(DISTINCT h.table_id) INTO v_base_ids
    FROM public.hand_history h
    JOIN public.tables t ON t.id = h.table_id
   WHERE h.created_at >= v_end - interval '12 min'
     AND h.created_at <  v_end - interval '7 min'
     AND t.status <> 'closed';
  v_base := COALESCE(cardinality(v_base_ids), 0);
  v_rec := NULL;
  IF v_base > 0 THEN
    FOR m IN 1..10 LOOP
      IF (SELECT count(DISTINCT h.table_id) FROM public.hand_history h
            WHERE h.table_id = ANY (v_base_ids)
              AND h.created_at >= v_end
              AND h.created_at <  v_end + make_interval(mins => m)) >= ceil(v_base * 0.8) THEN
        v_rec := m * 60; EXIT;
      END IF;
    END LOOP;
  END IF;

  -- THE ATTEMPT THAT SHIPPED, IF ONE DID (correction a). A later no-op in the
  -- same window ("coalesced or already serving this commit") is newer, and
  -- the newest used to win.
  SELECT target_sha, shipped INTO v_ship FROM public.ca_engine_deploy_attempts
   WHERE at >= v_start AND at < v_end + interval '6 min'
   ORDER BY shipped DESC, at DESC LIMIT 1;

  SELECT total INTO v_pre  FROM public.ca_freeze_circulation_marks WHERE window_hour = v_end AND kind='pre';
  SELECT total INTO v_post FROM public.ca_freeze_circulation_marks WHERE window_hour = v_end AND kind='post';
  IF v_pre IS NOT NULL AND v_post IS NOT NULL THEN
    v_delta := v_post - v_pre;
    v_conserved := (abs(v_delta) <= GREATEST(1.0, COALESCE(v_pre, 0) * 1e-7));
  ELSE v_delta := NULL; v_conserved := NULL; END IF;

  -- ── EACH FAILURE UNDER ITS OWN NAME, FOR THE MESSAGE ────────────────────
  -- Collected separately from the verdict below, whose single-CASE shape
  -- tests/the-break-clocks-agree.law.test.ts pins.
  -- array_append()/array_prepend(), never `||`: with an untyped literal on the
  -- right, `||` on a TEXT[] resolves to the array||array operator and fails
  -- at RUNTIME with "malformed array literal".
  IF v_hands IS NOT NULL THEN
    IF v_hands > c_max_hands THEN
      v_reasons := array_append(v_reasons, 'dealt_inside_break');
    END IF;
    IF COALESCE(v_thaw.frozen_seconds, 0) <= 0 THEN
      v_reasons := array_append(v_reasons, 'thaw_did_not_run');
    END IF;
    IF v_covered IS FALSE THEN
      v_reasons := array_append(v_reasons, 'break_missed_its_window');
    END IF;
    -- The cause goes in FRONT of its consequences. A break that never started
    -- deals through its window and has nothing to thaw, so the two reasons
    -- above follow from this one; the message reads them in this order.
    IF v_never_started THEN
      v_reasons := array_prepend('break_never_started'::text, v_reasons);
    END IF;
  END IF;

  -- `v_covered IS NOT FALSE`, deliberately: NULL means "no break log row was
  -- found", which is unmeasured, and unmeasured is not failed. That is the
  -- same rule the recovery-seconds sentinel taught on 2026-09-04.
  v_verdict := CASE
    WHEN v_hands IS NULL THEN 'unknown'
    WHEN v_hands <= c_max_hands
     AND COALESCE(v_thaw.frozen_seconds, 0) > 0
     AND v_covered IS NOT FALSE
    THEN 'pass'
    ELSE 'fail' END;

  INSERT INTO public.ca_break_scorecards AS s (
    break_ended_at, break_started_at, hands_in_window, tables_dealing_in_window,
    thaw_ran, thaw_frozen_seconds, kill_rebuilds_after, recovery_seconds,
    pre_break_tables, shipped_sha, shipped, freeze_conserved, freeze_delta, verdict, detail,
    unparked_at_countdown, peak_unparked, ready_for_restart_at, gate_opened)
  VALUES (
    v_end, v_start, v_hands, v_wtabs,
    (v_thaw.frozen_seconds IS NOT NULL), v_thaw.frozen_seconds, v_kill, v_rec,
    v_base, v_ship.target_sha, COALESCE(v_ship.shipped, FALSE), v_conserved, v_delta, v_verdict,
    jsonb_build_object(
      'pre_total', v_pre,
      'post_total', v_post,
      -- The window the hand count above was actually taken over, so nobody has
      -- to guess again which five minutes a number refers to.
      'measured_from', v_meas_start,
      'measured_to', v_meas_end,
      'measured_actual_break', (v_brk.break_started_at IS NOT NULL),
      'covered_the_hour', v_covered,
      'resumed_early_seconds', v_early_s,
      'started_late_seconds', v_late_start_s,
      'never_started', v_never_started,
      'fault_stage', v_fault_stage,
      'fault_outcome', v_fault_outcome,
      'fault_error', v_fault_error,
      'reasons', to_jsonb(v_reasons)),
    v_brk.unparked_at_countdown, v_brk.peak_unparked, v_brk.ready_for_restart_at,
    -- Correction b: the replacement engine writes a restart hour's log row and
    -- never saw readiness itself; a verified cutover inside the break did.
    CASE WHEN v_brk.unparked_at_countdown IS NULL THEN NULL
         ELSE (v_brk.ready_for_restart_at IS NOT NULL OR COALESCE(v_ship.shipped, false)) END)
  ON CONFLICT (break_ended_at) DO UPDATE SET
    hands_in_window = EXCLUDED.hands_in_window,
    tables_dealing_in_window = EXCLUDED.tables_dealing_in_window,
    thaw_ran = EXCLUDED.thaw_ran, thaw_frozen_seconds = EXCLUDED.thaw_frozen_seconds,
    kill_rebuilds_after = EXCLUDED.kill_rebuilds_after, recovery_seconds = EXCLUDED.recovery_seconds,
    pre_break_tables = EXCLUDED.pre_break_tables, shipped_sha = EXCLUDED.shipped_sha,
    shipped = EXCLUDED.shipped, freeze_conserved = EXCLUDED.freeze_conserved,
    freeze_delta = EXCLUDED.freeze_delta, verdict = EXCLUDED.verdict, detail = EXCLUDED.detail,
    unparked_at_countdown = EXCLUDED.unparked_at_countdown, peak_unparked = EXCLUDED.peak_unparked,
    ready_for_restart_at = EXCLUDED.ready_for_restart_at, gate_opened = EXCLUDED.gate_opened,
    recorded_at = now()
  RETURNING * INTO v_row;

  IF v_verdict = 'fail' THEN
    PERFORM public.fn_ca_break_scorecard_push(v_row);
  END IF;
  RETURN v_row;
END $function$;
-- Preserve the installed service-only boundary explicitly in this definition.
REVOKE ALL ON FUNCTION public.fn_ca_record_break_scorecard(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_record_break_scorecard(timestamptz) TO service_role;
COMMIT;
