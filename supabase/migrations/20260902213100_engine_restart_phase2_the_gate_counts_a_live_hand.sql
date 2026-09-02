-- ============================================================================
--  PHASE 2 OF 9 - THE GATE COUNTS A LIVE HAND, NOT A RAISED HAND (DB half)
--  The engine now hands out one row per break with what the gate itself saw.
--  The scorecard (phase 1) reads it, filling the column it could not before.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.engine_maintenance_break_log (
  break_started_at      TIMESTAMPTZ PRIMARY KEY,
  break_ended_at        TIMESTAMPTZ NOT NULL,
  unparked_at_countdown INTEGER NOT NULL,
  peak_unparked         INTEGER NOT NULL,
  ready_for_restart_at  TIMESTAMPTZ,
  tables_resumed        INTEGER NOT NULL,
  thaw_ok               BOOLEAN,
  engine_version        TEXT,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.engine_maintenance_break_log IS
  'One row per maintenance break, written by the engine at MaintenanceBreak.end(): tables with a hand in flight when the countdown began, the peak during it, the first instant readyForRestart opened (NULL = never), tables resumed, thaw result. Insert-only, service_role.';
ALTER TABLE public.engine_maintenance_break_log ENABLE ROW LEVEL SECURITY;

-- The scorecard gains the gate's own numbers.
ALTER TABLE public.ca_break_scorecards
  ADD COLUMN IF NOT EXISTS unparked_at_countdown INTEGER,
  ADD COLUMN IF NOT EXISTS peak_unparked         INTEGER,
  ADD COLUMN IF NOT EXISTS ready_for_restart_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gate_opened           BOOLEAN;

CREATE OR REPLACE FUNCTION public.fn_ca_record_break_scorecard(p_end TIMESTAMPTZ DEFAULT NULL)
RETURNS public.ca_break_scorecards
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_end   TIMESTAMPTZ := COALESCE(p_end, date_trunc('hour', now()));
  v_start TIMESTAMPTZ := v_end - interval '5 minutes';
  v_hands INTEGER; v_wtabs INTEGER;
  v_thaw  RECORD; v_kill INTEGER; v_base INTEGER; v_rec INTEGER;
  v_ship  RECORD; v_pre NUMERIC; v_post NUMERIC; v_conserved BOOLEAN; v_delta NUMERIC;
  v_gate  RECORD;
  v_verdict TEXT; v_row public.ca_break_scorecards; m INTEGER;
BEGIN
  SELECT count(*), count(DISTINCT table_id) INTO v_hands, v_wtabs
    FROM public.hand_history WHERE created_at >= v_start AND created_at < v_end;

  SELECT frozen_seconds, thawed_at INTO v_thaw
    FROM public.engine_maintenance_thaws
   WHERE freeze_started_at BETWEEN v_start - interval '3 min' AND v_start + interval '3 min'
   ORDER BY thawed_at DESC LIMIT 1;

  SELECT count(*) INTO v_kill FROM public.engine_recovery_events
   WHERE event = 'watchdog_kill_rebuild' AND created_at >= v_end AND created_at < v_end + interval '5 min';

  SELECT count(DISTINCT table_id) INTO v_base FROM public.hand_history
   WHERE created_at >= v_end - interval '12 min' AND created_at < v_end - interval '7 min';
  v_rec := NULL;
  IF v_base > 0 THEN
    FOR m IN 1..10 LOOP
      IF (SELECT count(DISTINCT table_id) FROM public.hand_history
            WHERE created_at >= v_end + make_interval(mins => m - 1)
              AND created_at <  v_end + make_interval(mins => m + 1)) >= ceil(v_base * 0.8) THEN
        v_rec := m * 60; EXIT;
      END IF;
    END LOOP;
  END IF;

  SELECT target_sha, shipped INTO v_ship FROM public.ca_engine_deploy_attempts
   WHERE at >= v_start AND at < v_end + interval '6 min' ORDER BY at DESC LIMIT 1;

  SELECT total INTO v_pre  FROM public.ca_freeze_circulation_marks WHERE window_hour = v_end AND kind='pre';
  SELECT total INTO v_post FROM public.ca_freeze_circulation_marks WHERE window_hour = v_end AND kind='post';
  IF v_pre IS NOT NULL AND v_post IS NOT NULL THEN
    v_delta := v_post - v_pre; v_conserved := (abs(v_delta) < 0.005);
  ELSE v_delta := NULL; v_conserved := NULL; END IF;

  -- PHASE 2: what the gate itself saw. The engine keys the row on the real
  -- countdown instant (~:55:04); match within three minutes of the boundary.
  SELECT unparked_at_countdown, peak_unparked, ready_for_restart_at INTO v_gate
    FROM public.engine_maintenance_break_log
   WHERE break_started_at BETWEEN v_start - interval '3 min' AND v_start + interval '3 min'
   ORDER BY recorded_at DESC LIMIT 1;

  v_verdict := CASE
    WHEN v_hands <= 50
     AND COALESCE(v_thaw.frozen_seconds, 0) > 0
     AND COALESCE(v_rec, 999) <= 180
     AND COALESCE(v_conserved, TRUE)
    THEN 'pass'
    WHEN v_hands IS NULL THEN 'unknown'
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
    jsonb_build_object('pre_total', v_pre, 'post_total', v_post),
    v_gate.unparked_at_countdown, v_gate.peak_unparked, v_gate.ready_for_restart_at,
    CASE WHEN v_gate.unparked_at_countdown IS NULL THEN NULL ELSE (v_gate.ready_for_restart_at IS NOT NULL) END)
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
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_record_break_scorecard(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_record_break_scorecard(TIMESTAMPTZ) TO service_role;

COMMIT;
