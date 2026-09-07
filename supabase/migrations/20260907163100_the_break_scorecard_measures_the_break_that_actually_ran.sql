-- 20260907163100_the_break_scorecard_measures_the_break_that_actually_ran.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS CHANGES, AND WHY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- On 2026-09-06 the scorecard for the 19:00 break said, and pushed to every
-- incident recipient:
--
--     "Maintenance Break At 19:00 Did Not Pass. Hands In Window 366 ..."
--
-- THE BREAK DEALT ZERO HANDS. Per-minute counts across the whole fleet:
--
--     18:49   514 hands / 290 tables     <- normal
--     18:53    23 /  23                  <- ramp down
--     18:54   (no rows)                  <- 329 dealing tables, all parked
--     18:55   (no rows)
--     18:56   (no rows)
--     18:57   (no rows)
--     18:58   (no rows)
--     18:59   366 / 183                  <- ALL 366, in one minute
--     19:00    66 /  66
--
-- Five consecutive minutes of literally zero hands platform-wide. The break
-- worked perfectly. What it did was END EARLY: `engine_maintenance_break_log`
-- records it as 18:53:48.433 -> 18:58:49.531, because a manual
-- `workflow_dispatch` deploy restarted the engine at 18:54:14 across the :53
-- announcement, and `MaintenanceBreak.restoreFromStore()` anchored the adopted
-- break to the new process's BOOT INSTANT instead of the wall clock. It
-- therefore finished 71 seconds before the hour that every player's countdown
-- was pointing at, and the 366 hands are legitimate play in 18:59.
--
-- This function measured a HARDCODED [hour - 5 min, hour) window. For a break
-- that ran 18:53:48 -> 18:58:48 that window overlaps the real break by about
-- 3:12 and contains 71 seconds of correctly-resumed play. So the number was
-- right and the sentence was false, which is worse than a wrong number: it
-- sent whoever read it looking for a dealing gate that had never failed.
--
-- TWO CHANGES, and they are deliberately separate questions:
--
--   1. HANDS ARE COUNTED OVER THE BREAK THAT ACTUALLY RAN — the
--      `break_started_at` / `break_ended_at` pair this function ALREADY reads
--      three statements later for the gate columns. If no log row exists
--      (an engine that died before recording one), it falls back to the fixed
--      window and says so in `detail`, because "I could not find the break" is
--      itself a finding.
--
--   2. WHETHER THE BREAK COVERED :55 -> :00 IS ITS OWN ASSERTION. An early
--      resume is a real defect — players were promised five minutes and the
--      felt came back under the countdown — but it is a DIFFERENT defect from
--      dealing inside the break, and it now fails the scorecard under its own
--      name rather than borrowing the other one's.
--
-- `fn_ca_break_scorecard_push` is updated in the same transaction so the
-- notification names whichever of the two actually happened. A message that
-- says the wrong thing confidently is the thing being fixed here; leaving the
-- push on its old wording would keep shipping it.
--
-- No DDL on any table: two CREATE OR REPLACE FUNCTION statements, one
-- transaction, one schema-cache reload (club-arena CLAUDE.md, production DDL
-- policy). `detail` is jsonb and already free-form, so the new findings need
-- no column.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_record_break_scorecard(
  p_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS ca_break_scorecards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_end   TIMESTAMPTZ := COALESCE(p_end, date_trunc('hour', now()));
  v_start TIMESTAMPTZ := v_end - interval '5 minutes';
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
  c_max_hands CONSTANT INTEGER := 50;
  -- How far the break may miss its :55 -> :00 shape before that is a finding.
  -- The observed healthy breaks start at :55:0x and end at :00:0x-:00:20, so a
  -- 30-second allowance is generous against measured behaviour and still
  -- catches the 71-second early resume that prompted this.
  c_edge_tolerance_s CONSTANT NUMERIC := 30;
BEGIN
  -- THE BREAK THAT ACTUALLY RAN. Read first now, because it defines the window
  -- everything else is measured over. Same lookup the gate columns used.
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

  SELECT count(*), count(DISTINCT table_id) INTO v_hands, v_wtabs
    FROM public.hand_history
   WHERE created_at >= v_meas_start AND created_at < v_meas_end;

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
    v_delta := v_post - v_pre;
    v_conserved := (abs(v_delta) <= GREATEST(1.0, COALESCE(v_pre, 0) * 1e-7));
  ELSE v_delta := NULL; v_conserved := NULL; END IF;

  -- ── EACH FAILURE UNDER ITS OWN NAME, FOR THE MESSAGE ────────────────────
  -- Collected separately from the verdict below. The verdict keeps the exact
  -- single-CASE shape `tests/the-break-clocks-agree.law.test.ts` pins — the
  -- three clauses it guards (hands inside the break fail it, a thaw that did
  -- not run fails it, an unmeasurable break is 'unknown') are untouched, and
  -- the fourth clause is added beside them rather than replacing the form.
  -- array_append(), not `||`: with an untyped literal on the right, `||` on a
  -- TEXT[] resolves to the array||array operator and fails at RUNTIME with
  -- "malformed array literal". The assertion at the foot of this migration
  -- caught exactly that on the first apply, and nothing was committed.
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
      'reasons', to_jsonb(v_reasons)),
    v_brk.unparked_at_countdown, v_brk.peak_unparked, v_brk.ready_for_restart_at,
    CASE WHEN v_brk.unparked_at_countdown IS NULL THEN NULL
         ELSE (v_brk.ready_for_restart_at IS NOT NULL) END)
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

-- ── THE PUSH SAYS WHICH FAULT IT FOUND ─────────────────────────────────────
-- The old message asserted a hand count as though a hand count were the whole
-- story: "Maintenance Break At 19:00 Did Not Pass. Hands In Window 366". A
-- reader has no way to tell from that whether the fleet dealt through a break
-- or resumed 71 seconds early, and those two send you to different files. The
-- reasons the verdict was reached are in `detail->'reasons'` now, so the
-- notification can simply say them.
CREATE OR REPLACE FUNCTION public.fn_ca_break_scorecard_push(p_row public.ca_break_scorecards)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_key TEXT; v_msg TEXT; v_why TEXT; r RECORD;
  v_reasons TEXT[];
BEGIN
  v_key := 'break-failed:' || to_char(p_row.break_ended_at, 'YYYYMMDD"T"HH24MI');
  IF EXISTS (SELECT 1 FROM public.notifications
              WHERE type = 'engine_break_failed' AND data->>'key' = v_key) THEN RETURN; END IF;

  SELECT array_agg(t.x) INTO v_reasons
    FROM jsonb_array_elements_text(COALESCE(p_row.detail->'reasons', '[]'::jsonb)) AS t(x);

  -- NEVER A BARE QUESTION MARK. "Recovery ?s" reads as a broken template
  -- rather than as an absent number, and the law
  -- `tests/the-break-clocks-agree.law.test.ts` pins that. Say the words.
  v_why := CASE
    WHEN v_reasons IS NULL OR array_length(v_reasons, 1) IS NULL THEN 'Unclassified'
    ELSE array_to_string(
      ARRAY(SELECT CASE x
              WHEN 'dealt_inside_break' THEN 'It Dealt '
                                             || COALESCE(p_row.hands_in_window::text, 'An Unmeasured Number Of')
                                             || ' Hands Inside The Break'
              WHEN 'thaw_did_not_run' THEN 'The Thaw Did Not Run'
              WHEN 'break_missed_its_window' THEN 'The Break Missed Its Window, Resuming '
                                             || COALESCE(round((p_row.detail->>'resumed_early_seconds')::numeric)::text || 's',
                                                         'An Unmeasured Time')
                                             || ' Early'
              ELSE x END
            FROM unnest(v_reasons) AS x), '. ')
  END;

  -- COALESCE every interpolated value. A scorecard written before this
  -- migration has no `measured_from`, and one NULL anywhere in a `||` chain
  -- makes the WHOLE message NULL — which is how an alert becomes a blank push
  -- nobody can act on.
  v_msg := 'Maintenance Break At ' || to_char(p_row.break_ended_at, 'HH24:MI')
    || ' Did Not Pass. ' || COALESCE(v_why, 'Unclassified')
    || '. Measured '
    || COALESCE(to_char((p_row.detail->>'measured_from')::timestamptz, 'HH24:MI:SS'), 'Not Recorded')
    || ' To '
    || COALESCE(to_char((p_row.detail->>'measured_to')::timestamptz, 'HH24:MI:SS'), 'Not Recorded')
    || ', Recovery ' || COALESCE(p_row.recovery_seconds::text || 's', 'Not Measured')
    || ', Shipped ' || CASE WHEN p_row.shipped THEN 'Yes' ELSE 'No' END;

  FOR r IN SELECT user_id FROM public.ca_incident_recipients WHERE active LOOP
    INSERT INTO public.notifications (user_id, type, title, message, data)
    VALUES (r.user_id, 'engine_break_failed', 'Engine Break Needs A Look', left(v_msg, 500),
            jsonb_build_object('key', v_key, 'break_ended_at', p_row.break_ended_at,
                               'reasons', COALESCE(p_row.detail->'reasons', '[]'::jsonb)));
  END LOOP;
END $function$;

-- ── NOBODY IN A BROWSER CALLS EITHER OF THESE ──────────────────────────────
-- Both are SECURITY DEFINER writers: the recorder writes a scorecard row and
-- the push inserts a notification for every incident recipient. Neither asks
-- who is calling, and neither should — they are an hourly pg_cron job and its
-- own helper, and there is no per-player version of "grade the maintenance
-- break". `check-definer-authorization` blocked this migration on exactly that
-- and was right to: before it, a browser role could have written an arbitrary
-- scorecard row and pushed a notification to Dan's phone from an anon session.
--
-- PUBLIC is named as well as the roles. Revoking `anon` and `authenticated`
-- while PUBLIC still holds EXECUTE reads as a fix and does nothing, because
-- both roles inherit it from PUBLIC.
--
-- pg_cron is unaffected: its jobs run as the job owner, which is the superuser
-- that owns these functions, and the recorder reaches the push through
-- PERFORM inside its own definer context.
--
-- GRANT/REVOKE are not in pgrst_ddl_watch's list, so these four statements add
-- no schema-cache reload to the two above.
REVOKE ALL ON FUNCTION public.fn_ca_record_break_scorecard(timestamp with time zone)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_record_break_scorecard(timestamp with time zone)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_break_scorecard_push(public.ca_break_scorecards)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_break_scorecard_push(public.ca_break_scorecards)
  TO service_role;

-- ── ASSERT THE NEW SHAPE AGAINST THE BREAK THAT PROMPTED IT ────────────────
-- Recomputing 2026-09-06 19:00 must now count over 18:53:48 -> 18:58:49 and
-- return zero hands, and must fail for `break_missed_its_window` rather than
-- for dealing. If the board has moved underneath this migration, it aborts.
DO $$
DECLARE
  v public.ca_break_scorecards;
BEGIN
  IF EXISTS (SELECT 1 FROM public.engine_maintenance_break_log
              WHERE break_started_at = '2026-09-06 18:53:48.433+00') THEN
    SELECT * INTO v FROM public.fn_ca_record_break_scorecard('2026-09-06 19:00:00+00');
    IF v.hands_in_window <> 0 THEN
      RAISE EXCEPTION 'expected 0 hands inside the real 18:53:48-18:58:49 break, got %', v.hands_in_window;
    END IF;
    -- jsonb_exists(), not the `?` operator: `?` is a parameter placeholder to
    -- several client drivers and gets rewritten before Postgres ever sees it.
    IF NOT jsonb_exists(v.detail->'reasons', 'break_missed_its_window') THEN
      RAISE EXCEPTION 'expected the early resume to be named; reasons were %', v.detail->'reasons';
    END IF;
    IF jsonb_exists(v.detail->'reasons', 'dealt_inside_break') THEN
      RAISE EXCEPTION 'the break dealt zero hands and must not be accused of dealing';
    END IF;
    RAISE NOTICE 'verified: 2026-09-06 19:00 rescored as % (%)', v.verdict, v.detail->'reasons';
  ELSE
    RAISE NOTICE 'the 2026-09-06 18:53:48 break log row is gone; skipping the historical assertion';
  END IF;
END $$;

COMMIT;
