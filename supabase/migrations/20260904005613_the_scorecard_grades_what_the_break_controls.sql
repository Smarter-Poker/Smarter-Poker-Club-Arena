-- ============================================================================
--  THE BREAK SCORECARD GRADES WHAT THE BREAK CONTROLS
--  (2026-09-04, after fifteen pages in twenty-four hours for breaks that worked)
-- ============================================================================
--
--  Dan was paged at 00:00 with:
--
--    "Maintenance Break At 00:00 Did Not Pass. Hands In Window 0, Thaw Ran,
--     Recovery ?s, Shipped No"
--
--  Read that message again. Hands in window ZERO. Thaw RAN. Those are the two
--  things the break exists to do, and both passed. The break was graded a
--  failure anyway, and it is the third time on this programme that a guard has
--  produced a confident answer it had no basis for.
--
--  In the twenty-four hours before this migration the scorecard recorded
--  pass=9, fail=15. Of the fifteen failures, FOURTEEN were freeze_conserved and
--  ONE was a null recovery. NONE of them were the break failing to stop play.
--  Meanwhile the break itself was in the best shape it has ever been:
--  unparked_at_countdown was 0 on ten of the last twelve breaks (it was 179 on
--  2026-09-02), gate_opened was true on eleven of twelve, thaw_ran was true on
--  all twelve, and hands_in_window ran 0-3 against a pre-fix baseline of 1204.
--
--  Two grading criteria were doing all the damage, and neither of them can be
--  interpreted the way the verdict was interpreting them.
--
--  -- 1. COALESCE(v_rec, 999) <= 180 -----------------------------------------
--
--  recovery_seconds is NULL when the fleet did not return to 80% of its
--  pre-break table count within ten minutes. Coalescing that to 999 asserts
--  "the worst case happened". It did not; the measurement simply did not
--  conclude, and there are innocent reasons for that:
--
--    - Demand genuinely fell. The 00:00 UTC break is 19:00 CDT, the start of
--      the evening decline. pre_break_tables was 413, the highest of the day.
--      Requiring ceil(413 * 0.8) = 331 tables back within ten minutes asks the
--      platform to hold its daily peak through a traffic drop. A healthy
--      platform fails that.
--    - pre_break_tables can be 0, in which case the loop never runs at all.
--
--  Note the asymmetry the original code already contained: v_hands IS NULL was
--  correctly routed to 'unknown', while v_rec IS NULL was coerced to a failing
--  sentinel. Unknown is not failure. It is now recorded, not graded.
--
--  -- 2. abs(v_delta) < 0.005 ------------------------------------------------
--
--  freeze_conserved compares total chips in circulation before and after the
--  window, where circulation is
--      sum(club_members.chip_balance) + sum(table_seats.stack WHERE left_at IS NULL).
--  That total is currently about 175,000,000. A tolerance of 0.005 chips is a
--  relative tolerance of roughly 3e-11. Nothing on a live platform holds that.
--  Observed deltas graded as failures: -0.32, -1.20, -2.62, 5.00, -5.25, -6.39,
--  6.77, -12.47, -60.00, 89.22. Every one is noise against 175 million.
--
--  But loosening the number is NOT the fix, because the metric cannot answer
--  the question it was asked. THE ENGINE IS EXEMPT FROM THE FREEZE BY DESIGN -
--  fn_refuse_while_frozen returns early for a service_role JWT claim, so that
--  in-flight hands can still settle. Every chip movement inside the 2026-09-03
--  00:55-01:00 window went through that exempt path: 57 tournament buy-ins, 52
--  buy-ins, 8 spin entries, 8 spin prizes, rake, BBJ, promo.
--
--  So a non-zero delta means "the engine and the scheduled economy jobs did
--  their work during the window", which is exactly what is supposed to happen.
--  It does not mean the freeze leaked.
--
--  AND IT CANNOT BE MADE TO MEAN THAT FROM THIS DATA. chip_ledger.db_role is
--  'postgres' for 100% of rows in the last 26 hours (564,751 PostgREST, 1,646
--  pg_cron, 32 Supavisor, 14 mgmt-api), because PostgREST executes as postgres
--  after applying the JWT. No column here separates an exempt engine write from
--  a client write, so no honest leak detector can be built from it. One was
--  considered and deliberately NOT built rather than shipping a guess.
--  Detecting a real breach needs the refusal side - a 55006 that should have
--  fired and did not - and that is separate work, recorded rather than invented.
--
--  -- WHAT THIS MIGRATION DOES -----------------------------------------------
--
--  The verdict now grades ONLY what the break controls and what this data can
--  support:
--
--    fail    - the break did not stop play (hands_in_window over the threshold)
--              or the clocks were not given back (thaw did not run).
--    unknown - hands_in_window could not be measured.
--    pass    - otherwise.
--
--  recovery_seconds and freeze_conserved are still computed, still written to
--  every row, still visible in the scorecard and the weekly report. They are
--  evidence. They are no longer a verdict and they no longer wake anyone.
--
--  This keeps the teeth that matter: the 2026-09-02 regression, where the break
--  dealt 1204 hands inside itself, still fails loudly on the first criterion.
--  What stops is fifteen pages a day for breaks that did their job.
--
--  Idempotent. No table rewrite. The only data change is re-grading historical
--  verdicts so the record agrees with the rule that now governs it.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '8s';

-- -- 1. The recorder: grade hands and thaw; record the rest -------------------
CREATE OR REPLACE FUNCTION public.fn_ca_record_break_scorecard(p_end TIMESTAMPTZ DEFAULT NULL)
RETURNS public.ca_break_scorecards
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_end   TIMESTAMPTZ := COALESCE(p_end, date_trunc('hour', now()));
  v_start TIMESTAMPTZ := v_end - interval '5 minutes';
  v_hands INTEGER; v_wtabs INTEGER;
  v_thaw  RECORD; v_kill INTEGER; v_base INTEGER; v_rec INTEGER;
  v_ship  RECORD; v_pre NUMERIC; v_post NUMERIC; v_conserved BOOLEAN; v_delta NUMERIC;
  v_gate  RECORD;
  v_verdict TEXT; v_row public.ca_break_scorecards; m INTEGER;
  -- The countable thing the break is responsible for. Deliberately generous:
  -- this is a regression alarm, not a performance target.
  c_max_hands CONSTANT INTEGER := 50;
BEGIN
  SELECT count(*), count(DISTINCT table_id) INTO v_hands, v_wtabs
    FROM public.hand_history WHERE created_at >= v_start AND created_at < v_end;

  SELECT frozen_seconds, thawed_at INTO v_thaw
    FROM public.engine_maintenance_thaws
   WHERE freeze_started_at BETWEEN v_start - interval '3 min' AND v_start + interval '3 min'
   ORDER BY thawed_at DESC LIMIT 1;

  SELECT count(*) INTO v_kill FROM public.engine_recovery_events
   WHERE event = 'watchdog_kill_rebuild' AND created_at >= v_end AND created_at < v_end + interval '5 min';

  -- Recovery is still measured and still worth watching over time. It is
  -- confounded by demand (see the header), so it is evidence, not a verdict.
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

  -- Circulation across the window. Recorded for the trend; NOT a verdict,
  -- because the engine is exempt from the freeze by design and this number
  -- therefore measures the economy working, not the freeze leaking.
  SELECT total INTO v_pre  FROM public.ca_freeze_circulation_marks WHERE window_hour = v_end AND kind='pre';
  SELECT total INTO v_post FROM public.ca_freeze_circulation_marks WHERE window_hour = v_end AND kind='post';
  IF v_pre IS NOT NULL AND v_post IS NOT NULL THEN
    v_delta := v_post - v_pre;
    -- Kept as a RELATIVE reading so the column stays meaningful to anyone
    -- graphing it: one part in ten million of circulation, one-chip floor.
    v_conserved := (abs(v_delta) <= GREATEST(1.0, COALESCE(v_pre, 0) * 1e-7));
  ELSE v_delta := NULL; v_conserved := NULL; END IF;

  SELECT unparked_at_countdown, peak_unparked, ready_for_restart_at INTO v_gate
    FROM public.engine_maintenance_break_log
   WHERE break_started_at BETWEEN v_start - interval '3 min' AND v_start + interval '3 min'
   ORDER BY recorded_at DESC LIMIT 1;

  -- THE VERDICT. Only what the break controls, and only what this data can
  -- support. Anything unmeasured is 'unknown', never 'fail'.
  v_verdict := CASE
    WHEN v_hands IS NULL THEN 'unknown'
    WHEN v_hands <= c_max_hands
     AND COALESCE(v_thaw.frozen_seconds, 0) > 0
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
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_record_break_scorecard(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_record_break_scorecard(TIMESTAMPTZ) TO service_role;

-- -- 2. The push: say what actually failed, and never render "?s" -------------
CREATE OR REPLACE FUNCTION public.fn_ca_break_scorecard_push(p_row public.ca_break_scorecards)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE r uuid; v_key text; v_msg text; v_why text;
BEGIN
  v_key := 'break-failed:' || to_char(p_row.break_ended_at, 'YYYYMMDD"T"HH24MI');
  IF EXISTS (SELECT 1 FROM public.notifications
              WHERE type = 'engine_break_failed' AND data->>'key' = v_key) THEN
    RETURN;
  END IF;

  -- Lead with the REASON. The old message listed four facts and left the reader
  -- to work out which one was the complaint - and at 00:00 the two it led with
  -- had both passed. It also rendered a null recovery as "Recovery ?s", which
  -- reads like a broken template rather than a missing measurement.
  v_why := CASE
    WHEN COALESCE(p_row.hands_in_window, 0) > 50
      THEN 'It Dealt ' || p_row.hands_in_window || ' Hands Inside The Break'
    WHEN NOT COALESCE(p_row.thaw_ran, FALSE)
      THEN 'The Thaw Did Not Run, So Player Clocks Were Not Given Back'
    ELSE 'See The Scorecard Row' END;

  v_msg := 'Maintenance Break At ' || to_char(p_row.break_ended_at, 'HH24:MI') || ' Did Not Pass: '
    || v_why || '. Hands In Window '
    || COALESCE(p_row.hands_in_window::text, 'Not Measured')
    || ', Thaw ' || CASE WHEN p_row.thaw_ran THEN 'Ran' ELSE 'Did Not Run' END
    || ', Recovery ' || COALESCE(p_row.recovery_seconds::text || 's', 'Not Measured')
    || ', Shipped ' || CASE WHEN p_row.shipped THEN 'Yes' ELSE 'No' END || '.';

  FOR r IN SELECT user_id FROM public.ca_incident_recipients WHERE active LOOP
    INSERT INTO public.notifications (user_id, type, title, message, data)
    VALUES (r, 'engine_break_failed', 'Engine Break Needs A Look', left(v_msg,500),
            jsonb_build_object('key', v_key, 'scorecard', to_jsonb(p_row)));
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_break_scorecard_push(public.ca_break_scorecards) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_break_scorecard_push(public.ca_break_scorecards) TO service_role;

-- -- 3. Make the historical record agree with the rule that now governs it ----
-- Rows previously graded 'fail' purely on recovery or conservation were not
-- failures of the break. Re-grade by the new rule. Genuine hands/thaw failures
-- keep their 'fail' exactly as they were.
UPDATE public.ca_break_scorecards
   SET verdict = CASE
         WHEN hands_in_window IS NULL THEN 'unknown'
         WHEN hands_in_window <= 50 AND COALESCE(thaw_frozen_seconds, 0) > 0 THEN 'pass'
         ELSE 'fail' END
 WHERE verdict IS DISTINCT FROM CASE
         WHEN hands_in_window IS NULL THEN 'unknown'
         WHEN hands_in_window <= 50 AND COALESCE(thaw_frozen_seconds, 0) > 0 THEN 'pass'
         ELSE 'fail' END;

COMMIT;
