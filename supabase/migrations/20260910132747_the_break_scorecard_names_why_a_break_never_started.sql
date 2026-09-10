-- 20260910132747_the_break_scorecard_names_why_a_break_never_started.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS CHANGES, AND WHY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- At 00:00 and 07:00 UTC on 2026-09-10 the hourly maintenance break never
-- happened. The engine could not save its :53 announcement - the write timed
-- out - so it cancelled the whole break, and the fleet dealt straight through
-- the five minutes it was meant to stand still: 750 hands at 00:00, 2,476 at
-- 07:00. The scorecard failed both, correctly, and then told Dan:
--
--     "Maintenance Break At 07:00 Did Not Pass. It Dealt 2476 Hands Inside
--      The Break. The Thaw Did Not Run. ... Shipped No"
--
-- Every clause true, and none of them the cause. There was no break to deal
-- inside and nothing to thaw. The one fact that explained all three - the
-- break never started, and why - was recorded nowhere, so the message sent
-- its reader to the dealing gate and the thaw, which had both done exactly
-- what they were told.
--
-- ── 1. engine_maintenance_break_faults (NEW) ───────────────────────────────
-- The engine (changed separately) inserts one row per fault through PostgREST
-- as service_role: which hour's break (announced_at, that hour's :53
-- instant), where it failed (stage), what it did about it (outcome), its own
-- error text, and its version. Insert-only evidence; no browser role can read
-- or write it.
--
-- ── 2. fn_ca_record_break_scorecard: four corrections, each found in today's
--       own rows ─────────────────────────────────────────────────────────────
--
--   a. SHIPPED READ THE WRONG ATTEMPT. The 10:00 row says shipped=false for a
--      break that cut f1992eeb over at 09:57:08 (ca_engine_deploy_attempts
--      356). A no-op attempt at 10:01:04 - "coalesced or already serving this
--      commit", 357 - fell in the same window and was newer, and the lookup
--      took the newest. It now prefers an attempt that shipped, newest first.
--
--   b. GATE_OPENED READ FALSE FOR BREAKS THAT CUT OVER. 09:00 and 10:00 say
--      gate_opened=false. On a restart hour the break-log row is written by
--      the REPLACEMENT engine, which boots after readiness was observed and so
--      never observes it itself. The deploy cuts over only on the
--      readyForRestart certificate, so a verified cutover inside the break
--      proves the gate opened. Still NULL when there is no break-log row.
--
--   c. A BREAK THAT NEVER STARTED SAYS SO. When there is no break-log row for
--      the hour, 'break_never_started' leads detail->'reasons', and the newest
--      fault the engine recorded against that hour's announcement
--      (announced_at in [:52, :55]) is copied into detail as fault_stage,
--      fault_outcome and fault_error. They are NULL when the engine recorded
--      no fault, which is itself the finding for any engine older than the
--      fault table.
--
--   d. RECOVERY MEASURES THE TABLES THAT CAN COME BACK. 10:00, 11:00 and 12:00
--      recorded 420-480 s although every open table was dealing again within
--      a minute or two. The old base was every table that dealt at :48-:53,
--      compared against a count of ANY tables dealing in a sliding two-minute
--      window, and tournament tables that finish during a break close and
--      never deal again: of the 195 tables that dealt at 09:48-09:53, 49 had
--      not dealt ten minutes after the break and all 49 were closed tournament
--      tables (11:00: 61 of 62; 12:00: 51 of 51). The base is now the tables
--      that dealt at :48-:53 AND are still open, and recovery is the first
--      minute by which 80% of THOSE SAME tables have dealt a hand after :00.
--      Derived against today's hand_history before this was written: 10:00
--      120 s, 11:00 60 s, 12:00 120 s. A re-score reads table status as it is
--      at re-score time, so a re-scored hour's base is smaller than the one
--      its :12 job saw (tables that came back and closed later drop out). That
--      can shrink the base; it cannot count a table that did not deal.
--
--   The verdict is untouched, deliberately. tests/the-break-clocks-agree.
--   law.test.ts pins its clauses in the newest migration that defines this
--   function, and none of the four corrections changes whether a break passes:
--   they change what the row says about it. The assertion block at the foot
--   proves that on every hour already scored today.
--
-- ── 3. fn_ca_break_scorecard_push names the cause ──────────────────────────
-- 'break_never_started' renders as the stage the engine reported ("The :53
-- Announcement Could Not Be Saved (<error>)", "A Restarted Engine Could Not
-- Declare It (<error>)", or the stage and error as recorded), or says the
-- engine recorded no reason. A break that never started has nothing to
-- recover from, so its recovery clause reads "Not Applicable" instead of a
-- number. The dedupe key, the title and the recipient loop are unchanged.
--
-- ── HOW IT IS APPLIED ──────────────────────────────────────────────────────
-- ONE transaction: the CREATE TABLE, its index, RLS, a COMMENT and two CREATE
-- OR REPLACE FUNCTION coalesce into one schema-cache reload (club-arena
-- CLAUDE.md, production DDL policy). lock_timeout 2s, so nothing here queues
-- in front of a live table. TIME ZONE UTC because the push's dedupe key is
-- rendered by to_char in the session time zone and the hourly job runs in
-- UTC: re-scoring a failed hour from any other zone would mint a fresh key and
-- page Dan again. In UTC it finds 'break-failed:<hour>' already sent and
-- stays silent.

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL TIME ZONE 'UTC';

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. THE FAULT RECORD
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE public.engine_maintenance_break_faults (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The :53 instant of the hour whose break this fault is about.
  announced_at   TIMESTAMPTZ NOT NULL,
  stage          TEXT        NOT NULL
                 CHECK (stage IN ('announcement', 'countdown', 'adoption', 'boot')),
  outcome        TEXT        NOT NULL
                 CHECK (outcome IN ('cancelled', 'held_without_restart')),
  error          TEXT,
  engine_version TEXT,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_engine_maintenance_break_faults_announced_at
  ON public.engine_maintenance_break_faults (announced_at);

ALTER TABLE public.engine_maintenance_break_faults ENABLE ROW LEVEL SECURITY;

-- Supabase's default privileges hand every new public table to anon and
-- authenticated in full. RLS with no policy refuses them today, but a grant
-- nobody needs is a grant waiting for the day somebody adds a permissive
-- policy. service_role is revoked as well and given back exactly what the
-- engine uses: a fault is evidence, and evidence is appended, never edited.
-- GRANT/REVOKE are not in pgrst_ddl_watch's list and add no reload.
REVOKE ALL ON TABLE public.engine_maintenance_break_faults
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.engine_maintenance_break_faults TO service_role;

COMMENT ON TABLE public.engine_maintenance_break_faults IS
  'One row per maintenance-break fault, written by the engine through PostgREST as service_role at the moment a break could not proceed. announced_at is the :53 instant of that hour''s break; stage is where it failed (announcement, countdown, adoption, boot); outcome is what the engine did about it (cancelled the break, or held it without restarting); error is the engine''s own message. fn_ca_record_break_scorecard copies the newest fault for an hour whose break never started into the scorecard detail, and fn_ca_break_scorecard_push names it. Insert-only evidence: service_role may SELECT and INSERT; no browser role may do either.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. THE RECORDER
-- ═══════════════════════════════════════════════════════════════════════════
-- Production's body (20260907163100 plus the event_class patch applied in
-- place by 20260908133319), with corrections a-d above and nothing else.
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. THE PUSH NAMES THE CAUSE
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_ca_break_scorecard_push(p_row public.ca_break_scorecards)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_key TEXT; v_msg TEXT; v_why TEXT; r RECORD;
  v_reasons TEXT[];
  -- What a break that never started carries in detail. A row scored before
  -- 20260910132747 has no never_started key and reads as a break that ran.
  v_never_started BOOLEAN := COALESCE((p_row.detail->>'never_started')::boolean, false);
  v_fault_stage   TEXT    := p_row.detail->>'fault_stage';
  -- Capped so a long engine message cannot push the measurements off the end
  -- of the 500-character notification. The whole text stays in detail and in
  -- engine_maintenance_break_faults.
  v_fault_error   TEXT    := COALESCE(left(p_row.detail->>'fault_error', 200), 'No Error Recorded');
  v_never_text    TEXT;
BEGIN
  v_key := 'break-failed:' || to_char(p_row.break_ended_at, 'YYYYMMDD"T"HH24MI');
  IF EXISTS (SELECT 1 FROM public.notifications
              WHERE type = 'engine_break_failed' AND data->>'key' = v_key) THEN RETURN; END IF;

  SELECT array_agg(t.x) INTO v_reasons
    FROM jsonb_array_elements_text(COALESCE(p_row.detail->'reasons', '[]'::jsonb)) AS t(x);

  -- WHY THE BREAK NEVER STARTED, in the engine's own terms: the stage it
  -- failed at decides the sentence, and its error text goes in brackets.
  v_never_text := CASE
    WHEN v_fault_stage IS NULL THEN
      'The Break Never Started, And The Engine Recorded No Reason'
    WHEN v_fault_stage = 'announcement' THEN
      'The Break Never Started: The :53 Announcement Could Not Be Saved (' || v_fault_error || ')'
    WHEN v_fault_stage = 'boot' THEN
      'The Break Never Started: A Restarted Engine Could Not Declare It (' || v_fault_error || ')'
    ELSE
      'The Break Never Started (' || COALESCE(v_fault_stage, 'Unknown Stage') || ': ' || v_fault_error || ')'
  END;

  -- NEVER A BARE QUESTION MARK. "Recovery ?s" reads as a broken template
  -- rather than as an absent number, and the law
  -- `tests/the-break-clocks-agree.law.test.ts` pins that. Say the words.
  v_why := CASE
    WHEN v_reasons IS NULL OR array_length(v_reasons, 1) IS NULL THEN 'Unclassified'
    ELSE array_to_string(
      ARRAY(SELECT CASE x
              WHEN 'break_never_started' THEN v_never_text
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

  -- COALESCE every interpolated value. One NULL anywhere in a `||` chain makes
  -- the WHOLE message NULL, which is how an alert becomes a blank push nobody
  -- can act on. A break that never started has no recovery to measure, so it
  -- says so rather than printing a number measured across a break that did
  -- not happen.
  v_msg := 'Maintenance Break At ' || to_char(p_row.break_ended_at, 'HH24:MI')
    || ' Did Not Pass. ' || COALESCE(v_why, 'Unclassified')
    || '. Measured '
    || COALESCE(to_char((p_row.detail->>'measured_from')::timestamptz, 'HH24:MI:SS'), 'Not Recorded')
    || ' To '
    || COALESCE(to_char((p_row.detail->>'measured_to')::timestamptz, 'HH24:MI:SS'), 'Not Recorded')
    || ', Recovery '
    || CASE WHEN v_never_started THEN 'Not Applicable'
            ELSE COALESCE(p_row.recovery_seconds::text || 's', 'Not Measured') END
    || ', Shipped ' || CASE WHEN p_row.shipped THEN 'Yes' ELSE 'No' END;

  FOR r IN SELECT user_id FROM public.ca_incident_recipients WHERE active LOOP
    INSERT INTO public.notifications (user_id, type, title, message, data)
    VALUES (r.user_id, 'engine_break_failed', 'Engine Break Needs A Look', left(v_msg, 500),
            jsonb_build_object('key', v_key, 'break_ended_at', p_row.break_ended_at,
                               'reasons', COALESCE(p_row.detail->'reasons', '[]'::jsonb)));
  END LOOP;
END $function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. NOBODY IN A BROWSER CALLS EITHER OF THESE
-- ═══════════════════════════════════════════════════════════════════════════
-- Unchanged from 20260907163100: both are SECURITY DEFINER writers run by the
-- hourly pg_cron job and its own helper. CREATE OR REPLACE keeps the existing
-- ACL, and restating it here keeps check-definer-authorization reading the
-- truth. PUBLIC is named as well as the roles, because anon and authenticated
-- inherit EXECUTE from PUBLIC.
REVOKE ALL ON FUNCTION public.fn_ca_record_break_scorecard(timestamp with time zone)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_record_break_scorecard(timestamp with time zone)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_break_scorecard_push(public.ca_break_scorecards)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_break_scorecard_push(public.ca_break_scorecards)
  TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. PROVE IT ON TODAY'S ROWS, OR COMMIT NOTHING
-- ═══════════════════════════════════════════════════════════════════════════
-- Re-scoring a failed hour does not page again: the push finds its
-- 'break-failed:<hour>' key already sent. Any mismatch below raises, and the
-- raise takes the table, both functions and every re-score with it.
DO $$
DECLARE
  v        public.ca_break_scorecards;
  v_hour   timestamptz;
  v_before text;
  v_n      integer := 0;
BEGIN
  -- Every hour of 2026-09-10 the :12 job has already scored, under the new
  -- definitions. No verdict may move: these corrections change what a row
  -- says, not whether a break passed, and a verdict that moved to 'fail'
  -- would page under a key that was never sent.
  FOR v_hour IN
    SELECT g FROM generate_series('2026-09-10 00:00:00+00'::timestamptz,
                                  '2026-09-10 23:00:00+00'::timestamptz,
                                  interval '1 hour') AS g
  LOOP
    SELECT s.verdict INTO v_before FROM public.ca_break_scorecards s WHERE s.break_ended_at = v_hour;
    CONTINUE WHEN NOT FOUND;
    SELECT * INTO v FROM public.fn_ca_record_break_scorecard(v_hour);
    IF v.verdict IS DISTINCT FROM v_before THEN
      RAISE EXCEPTION 'rescoring % moved its verdict from % to %; these corrections must not regrade a break',
        v_hour, v_before, v.verdict;
    END IF;
    v_n := v_n + 1;
    RAISE NOTICE 'rescored %: verdict %, shipped % %, gate_opened %, recovery % over % open tables, reasons %',
      to_char(v_hour, 'HH24:MI'), v.verdict, v.shipped, left(v.shipped_sha, 8), v.gate_opened,
      v.recovery_seconds, v.pre_break_tables, v.detail->'reasons';
  END LOOP;

  -- a + b + d: 10:00 cut f1992eeb over at 09:57:08, which proves its gate
  -- opened, and every open table was dealing again inside two minutes.
  SELECT * INTO v FROM public.fn_ca_record_break_scorecard('2026-09-10 10:00:00+00');
  IF v.shipped IS NOT TRUE OR COALESCE(v.shipped_sha, '') NOT LIKE 'f1992eeb%' THEN
    RAISE EXCEPTION '10:00 must read shipped f1992eeb; got shipped=% sha=%', v.shipped, v.shipped_sha;
  END IF;
  IF v.gate_opened IS NOT TRUE THEN
    RAISE EXCEPTION '10:00 cut over inside its break, so its gate opened; got gate_opened=%', v.gate_opened;
  END IF;
  IF v.recovery_seconds IS NULL OR v.recovery_seconds > 180 THEN
    RAISE EXCEPTION '10:00 recovery must be measured over the open tables (was 420 s); got %', v.recovery_seconds;
  END IF;
  IF ((v.detail->>'never_started')::boolean) IS NOT FALSE THEN
    RAISE EXCEPTION '10:00 ran its break and must not read as never started; detail %', v.detail;
  END IF;

  -- c: 07:00 and 00:00 never started. The cause leads the reasons.
  FOREACH v_hour IN ARRAY ARRAY['2026-09-10 07:00:00+00', '2026-09-10 00:00:00+00']::timestamptz[] LOOP
    SELECT * INTO v FROM public.fn_ca_record_break_scorecard(v_hour);
    IF v.verdict IS DISTINCT FROM 'fail'
       OR (v.detail->'reasons'->>0) IS DISTINCT FROM 'break_never_started' THEN
      RAISE EXCEPTION '% never started and must fail leading with break_never_started; got % %',
        v_hour, v.verdict, v.detail->'reasons';
    END IF;
    IF ((v.detail->>'never_started')::boolean) IS NOT TRUE THEN
      RAISE EXCEPTION '% has no break-log row and must read never_started; detail %', v_hour, v.detail;
    END IF;
  END LOOP;

  RAISE NOTICE 'verified: % hours rescored; 10:00 shipped and opened its gate; 07:00 and 00:00 lead with break_never_started', v_n;
END $$;

COMMIT;
