-- ============================================================================
-- THE BOARD CAN CLOSE, AND SILENCE IS NEVER CALLED A FIX
-- ============================================================================
-- Measured on production 2026-09-20 18:18 UTC. NOT YET APPLIED.
--
-- WHAT IS WRONG
-- -------------
-- public.ca_drift_incidents holds 170 open rows, 131 of them critical, against
-- roughly 13 conditions that are actually live. The owner sees a permanently
-- red board, so the board has stopped carrying information.
--
-- 160 of the 170 are mirrors: trg_ca_financial_alert_incident and
-- trg_ca_reconcile_log_incident copy every financial_alerts /
-- ledger_reconcile_log row onto the board. 130 of those sit on the detector
-- storm cap - five sources with 25 capped rows plus one storm: row each.
--
-- THE ROOT CAUSE IS NOT A MISSING MECHANISM. IT IS AN UNCONFIGURED ONE.
-- fn_ca_incident_escalation_tick has run every minute since Phase 6.3
-- (cron.job 162, '* * * * *') and already contains exactly the retirement rule
-- this board needs, keyed on ca_detector_registry.auto_resolve_hours:
-- "if the same dedupe_key has not been seen again for that long, the finding
-- cleared itself". It retires nothing because auto_resolve_hours is NULL for
-- all 26 sources that currently hold an open incident. Only 13 of the 124
-- registry rows carry a value at all, and none of those 13 has an open row.
--
-- So: no new cron, no new sweep, no new watcher, no new repair job (law 10.12).
-- The already-scheduled mechanism is given the policy it never had.
--
-- AND THE MECHANISM, AS WRITTEN, LIES
-- -----------------------------------
-- The tick closes a silence-retired row as status='resolved' with
--     correction_ref = 'verified: not seen again for N hours ...'
-- "verified:" is one of the evidence prefixes enforced by
-- fn_ca_resolution_needs_a_cause. An event stream going quiet is not evidence
-- that anything was fixed; it is "I could not tell" (law 10.86 rule 1), and it
-- is currently written into the same field, with the same word, as a genuine
-- re-measured all-clear. 43 rows already carry that wording (10 critical),
-- between 2026-09-05 20:37 and 2026-09-18 11:20 UTC, and they are
-- indistinguishable from verified closures today. This migration gives that
-- outcome its own name, forbids it from borrowing the word "verified", and
-- corrects those 43 rows forward.
--
-- WHY A closure_basis COLUMN AND NOT A NEW status VALUE
-- -----------------------------------------------------
-- A new status ('aged_out') was designed first and rejected on measurement.
-- "Still open" is written as status <> 'resolved' in ELEVEN function bodies,
-- including two release gates (fn_ca_epoch3_preflight,
-- fn_ca_midway_burnin_gate), the board metrics (fn_ca_drift_metrics,
-- fn_ca_daily_attestation, fn_ca_gate_panel) and - decisively - in
-- fn_ca_raise_drift_incident's storm cap and dedupe fold, plus BOTH partial
-- indexes:
--     ix_ca_drift_incidents_open         WHERE status <> 'resolved'
--     ux_ca_drift_incidents_open_dedupe  WHERE status <> 'resolved'
-- A terminal status that is not the literal 'resolved' keeps occupying that
-- unique dedupe slot and its seat under the 25-row storm cap. The condition
-- recurs, the raiser folds onto a closed row instead of filing a fresh one,
-- and the board stays silent. That is precisely the "silently break a reader
-- or resurrect rows" failure, and avoiding it costs eleven function rewrites,
-- two index rebuilds and a client type change.
--
-- status='resolved' + closure_basis costs four objects and has NO resurrection
-- hazard: the row leaves the unique index, so a recurrence files a new
-- incident - which is what both existing closers already promise in their own
-- resolution text.
--
-- The distinction is not weaker for living in a column. It is:
--   * constrained   - ca_drift_incidents_closure_basis_check
--   * enforced      - fn_ca_resolution_needs_a_cause now REFUSES the prefix
--                     "verified:" on an aged-out row and REFUSES "aged-out:"
--                     on any other, so the two can never be confused
--   * consequential - fn_ca_incident_resolution_reaches_the_alerts no longer
--                     marks the underlying financial_alerts row resolved when
--                     an incident merely aged out. An unverified closure must
--                     not carry a false answer into a second table.
--
-- THE THRESHOLD IS DERIVED, NOT GUESSED (law 10.84)
-- -------------------------------------------------
-- For each mirror source, the gap between consecutive ca_incident_events rows
-- of kind created|recurred was measured over the trailing 11 days, and
-- auto_resolve_hours set to ceil(3 x p99_gap), floored at 24h. Three times the
-- source's own 99th-percentile ordinary gap means a source must fall silent for
-- three times its worst normal quiet spell before anything retires; the 24h
-- floor stops a chatty source (p99 = 0.03h) aging out within minutes. Every
-- measurement is written beside its value in section 6.
--
-- Only EVENT MIRRORS are configured. Polling detectors that re-measure the
-- whole standing state are left to fn_ca_resolve_cleared_incidents, which
-- closes them as genuinely verified after two clean recorded runs - strictly
-- better evidence than silence, and already scheduled hourly (cron.job 357).
--
-- WHAT THIS MIGRATION CLOSES: NOTHING.
-- It sets policy. The already-scheduled tick applies it within one minute.
-- Projected against the board as measured 2026-09-20 18:18 UTC:
--     128 rows age out (120 of them critical), 42 rows are held.
-- The projection is recomputed and asserted in section 9, so this aborts
-- rather than landing if the board has moved into a shape these windows
-- would overrun.
--
-- THE SAFETY NET IS ALREADY THERE. fn_ca_escalate_reconcile_criticals
-- (cron.job 226, '52 * * * *') re-reads ledger_reconcile_log over a 36h
-- lookback and re-raises anything whose newest reading is still critical,
-- under the same dedupe key. Any ledger_reconcile_log finding aged out here
-- while still live comes back as a fresh incident within the hour. The mirror
-- triggers do the same for financial_alerts on the next alert written.
--
-- fn_ca_close_incidents_the_check_no_longer_finds IS DROPPED
-- ----------------------------------------------------------
-- It has no caller and is defective in the DANGEROUS direction, not merely the
-- useless one. It re-runs each check as a bare
-- `SELECT count(*) FROM public.<fn>()`, discarding the arguments and filters
-- the sweep registered:
--   * fn_tournament_chip_conservation_check is registered by the sweep with
--     tolerance 0.01 but DEFAULTS to 1 - a bare re-run is 100x more permissive
--     and would CLOSE an incident the sweep is still actively raising;
--   * fn_ca_payout_rows_without_money is registered with 3 days, defaults to 30;
--   * fn_chip_integrity_report is registered as WHERE severity <> 'ok' but
--     returns healthy rows too, so a bare count is never 0;
--   * fn_settler_lag_check, fn_bbj_conservation_check, fn_bbj_promo_bank_check,
--     fn_tournament_guarantee_check, fn_union_law_integrity_breaches and
--     fn_union_house_club_stamp_check each return a scalar, so
--     count(*) FROM fn() is always 1 and they could never close.
-- Fixing it properly means re-running the sweep's REGISTERED query text, which
-- lives as a VALUES literal inside fn_ca_conservation_sweep; a correct version
-- requires extracting that list into a table both functions read - a larger
-- change than this one should carry, and noted as the follow-up. It is also
-- redundant: fn_ca_resolve_cleared_incidents already closes
-- fn_ca_conservation_sweep:% rows on the sweep's own recorded runs.
--
-- DDL POLICY: one transaction, one PostgREST reload (CLAUDE.md section 2
-- rule 1). Do NOT apply between :50 and :03 UTC - the break-window event
-- triggers roll the whole thing back (section 2 rule 8).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. ASSERTIONS. Abort if this is not the board that was measured.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_open      int;
  v_crit      int;
  v_mismatch  int;
  v_missing   text;
  v_preconfig int;
BEGIN
  -- status and resolved_at agreed on all 6,225 rows on 2026-09-20. The whole
  -- design rests on 'resolved' meaning exactly "terminal". If that has stopped
  -- being true, stop.
  SELECT count(*) INTO v_mismatch
    FROM public.ca_drift_incidents
   WHERE (status = 'resolved') <> (resolved_at IS NOT NULL);
  IF v_mismatch <> 0 THEN
    RAISE EXCEPTION 'ABORT: % row(s) disagree between status and resolved_at. Measured 0 of 6225 on 2026-09-20 18:18 UTC. The closure model changed; re-read before applying.', v_mismatch;
  END IF;

  -- Board volume. Measured 170 open / 131 critical. A band, not an equality:
  -- the board legitimately moves every hour, but a wild swing means this was
  -- written against a different problem.
  SELECT count(*), count(*) FILTER (WHERE severity = 'critical')
    INTO v_open, v_crit
    FROM public.ca_drift_incidents WHERE status <> 'resolved';
  IF v_open NOT BETWEEN 100 AND 280 THEN
    RAISE EXCEPTION 'ABORT: % open incidents, expected 100-280 (measured 170 on 2026-09-20 18:18 UTC).', v_open;
  END IF;

  -- Every source configured below must already exist and be active, so a typo
  -- cannot quietly create a dead registry row that configures nothing.
  SELECT string_agg(s, ', ') INTO v_missing FROM (
    SELECT s FROM unnest(ARRAY[
      'financial_alerts:Tournament.atomic_finish_refused',
      'financial_alerts:Tournament.atomic_satellite_finish_refused',
      'financial_alerts:Tournament.atomic_satellite_finish_outcome_unknown',
      'financial_alerts:Tournament.atomic_finish_outcome_unknown',
      'financial_alerts:postHandTasks.hand_history_failed',
      'financial_alerts:postHandTasks.leave_pending_failed',
      'financial_alerts:fn_union_treasury_selftest',
      'financial_alerts:RakeSpec.drift',
      'financial_alerts:ServerTableEngine.authoritative_hand_unreachable',
      'financial_alerts:union_accounting_scheduler',
      'financial_alerts:weekly_club_accounting',
      'ledger_reconcile_log:rake_law',
      'ledger_reconcile_log:under_spec',
      'ledger_reconcile_log:board_not_recorded',
      'ledger_reconcile_log:reconcile_ledger_nightly'
    ]) AS s
    WHERE NOT EXISTS (SELECT 1 FROM public.ca_detector_registry r
                       WHERE r.source = s AND r.status = 'active')
  ) miss;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: these sources are not active in ca_detector_registry: %', v_missing;
  END IF;

  -- None may already carry a deliberate auto_resolve_hours. Measured: all 15
  -- NULL on 2026-09-20. If somebody has since tuned one by hand, this would
  -- silently overwrite their number.
  SELECT count(*) INTO v_preconfig
    FROM public.ca_detector_registry
   WHERE auto_resolve_hours IS NOT NULL
     AND (source LIKE 'financial_alerts:%' OR source LIKE 'ledger_reconcile_log:%');
  IF v_preconfig <> 0 THEN
    RAISE EXCEPTION 'ABORT: % mirror source(s) already carry auto_resolve_hours. Measured 0 on 2026-09-20 18:18 UTC; somebody configured one since. Reconcile by hand.', v_preconfig;
  END IF;

  RAISE NOTICE 'Pre-flight OK: % open (% critical), 0 status/resolved_at mismatches, 15 mirror sources active and unconfigured.', v_open, v_crit;
END $$;

-- ---------------------------------------------------------------------------
-- 1. "I could not tell" gets its own name.
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_drift_incidents
  ADD COLUMN IF NOT EXISTS closure_basis text;

ALTER TABLE public.ca_drift_incidents
  DROP CONSTRAINT IF EXISTS ca_drift_incidents_closure_basis_check;

ALTER TABLE public.ca_drift_incidents
  ADD CONSTRAINT ca_drift_incidents_closure_basis_check
  CHECK (closure_basis IS NULL OR closure_basis = ANY (ARRAY[
    'verified_remeasured',   -- a detector re-measured and did not report it
    'aged_out_unverified',   -- the stream went quiet. NOT a verified fix.
    'operator',              -- a person closed it and wrote why
    'repair'                 -- closed by a settlement that moved money
  ]));

COMMENT ON COLUMN public.ca_drift_incidents.closure_basis IS
  'WHY this incident is closed, which is a different question from whether it is closed. '
  '''verified_remeasured'': a detector that reads the whole standing state ran again and did not '
  'report it. ''aged_out_unverified'': the event stream merely went quiet for longer than the '
  'source''s own measured cadence (ca_detector_registry.auto_resolve_hours). That is NOT evidence '
  'the condition was fixed - it is equally what a dead writer looks like - and law 10.86 rule 1 '
  'requires the outcome to carry its own name rather than be folded into silence. NULL on rows '
  'closed before 2026-09-20.';

-- ---------------------------------------------------------------------------
-- 2. An aged-out row may never borrow the word "verified".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_resolution_needs_a_cause()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cause text := btrim(coalesce(NEW.root_cause, ''));
  v_ref   text := btrim(coalesce(NEW.correction_ref, ''));
  -- COALESCE, not a bare comparison: a NULL closure_basis must read as "not
  -- aged out" (false), never as NULL, or both fences below silently pass.
  v_aged  boolean := COALESCE(NEW.closure_basis = 'aged_out_unverified', false);
  v_ok    boolean;
BEGIN
  IF NEW.status <> 'resolved' OR OLD.status = 'resolved' THEN
    RETURN NEW;
  END IF;

  IF length(v_cause) < 40 THEN
    RAISE EXCEPTION
      'An incident is not resolved until the cause is written down. Supply root_cause: what was actually wrong, in a sentence (at least 40 characters). Got %.',
      CASE WHEN v_cause = '' THEN 'nothing' ELSE '"' || v_cause || '"' END
      USING ERRCODE = 'P0404';
  END IF;

  -- 2026-09-01: the auto_repair_status='repaired' bypass is GONE. Any writer
  -- could set that flag in the same UPDATE that resolved, which made the law
  -- optional for exactly the actor it was written to govern (the same shape
  -- as the [allow-revert] token incident of 2026-08-31). The automated
  -- reconciler now writes 'verified: <evidence>' like every other resolver.
  --
  -- 2026-09-20: 'aged-out:' joins the list, FENCED OFF from 'verified:' in
  -- BOTH directions. Until today the escalation tick closed a silence-retired
  -- incident with correction_ref 'verified: not seen again for N hours', so an
  -- unread event stream and a re-measured all-clear were recorded with the
  -- same word in the same field - 43 rows carry that wording. Silence is
  -- "I could not tell" (law 10.86 rule 1). It gets its own prefix, and the two
  -- can no longer be mistaken for one another.
  v_ok := v_ref ~* '^(migration\s+\S|PR\s*#\d|chip_ledger\s+\S|correction:\S)'
       OR v_ref ~* '^(ruling:|verified:|no-change-needed:|aged-out:)\s*\S';

  IF NOT v_ok THEN
    RAISE EXCEPTION
      'An incident is not resolved until something stops it happening again. Supply correction_ref as one of: "migration <name>", "PR #<n>", "chip_ledger <id>", "correction:<key>", "ruling: <decision>", "verified: <evidence>", "aged-out: <what went quiet>", or "no-change-needed: <why>". Got %.',
      CASE WHEN v_ref = '' THEN 'nothing' ELSE '"' || v_ref || '"' END
      USING ERRCODE = 'P0404';
  END IF;

  IF v_aged AND v_ref !~* '^aged-out:\s*\S' THEN
    RAISE EXCEPTION
      'closure_basis is ''aged_out_unverified'', so correction_ref must begin "aged-out: ". An incident retired because its event stream went quiet was not verified, and must not be filed under any evidence prefix. Got %.',
      CASE WHEN v_ref = '' THEN 'nothing' ELSE '"' || v_ref || '"' END
      USING ERRCODE = 'P0404';
  END IF;

  IF NOT v_aged AND v_ref ~* '^aged-out:' THEN
    RAISE EXCEPTION
      'correction_ref begins "aged-out: " but closure_basis is %. Set closure_basis to ''aged_out_unverified'', or supply real evidence under one of the other prefixes.',
      COALESCE('''' || NEW.closure_basis || '''', 'not set')
      USING ERRCODE = 'P0404';
  END IF;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. An unverified closure does not close the alert underneath it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_incident_resolution_reaches_the_alerts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_note text; v_state text; v_msg text;
BEGIN
  IF NEW.status <> 'resolved' OR COALESCE(OLD.status,'') = 'resolved' THEN
    RETURN NEW;
  END IF;

  /* AN AGE-OUT IS NOT A RESOLUTION AND MUST NOT PROPAGATE AS ONE (2026-09-20).
     This trigger marks the financial_alerts rows behind an incident resolved.
     An incident retired only because its stream went quiet has established
     nothing about those alerts, so closing them would carry "I could not tell"
     into a second table dressed as an answer. The incident closes; the alert
     stays open for whoever reads financial_alerts directly. */
  IF COALESCE(NEW.closure_basis = 'aged_out_unverified', false) THEN
    RETURN NEW;
  END IF;

  v_note := 'Closed with drift incident ' || NEW.id::text || ': '
            || COALESCE(NULLIF(NEW.resolution,''), 'no note given on the incident');

  UPDATE public.financial_alerts f
     SET resolved = true, resolved_at = now(),
         resolution = COALESCE(NULLIF(f.resolution,'') || ' | ','') || v_note
   WHERE NOT COALESCE(f.resolved,false)
     AND f.context->>'incident_id' ~ '^[0-9a-fA-F-]{36}$'
     AND (f.context->>'incident_id')::uuid = NEW.id;

  IF NEW.metadata->>'alert_id' ~ '^[0-9a-fA-F-]{36}$' THEN
    UPDATE public.financial_alerts f
       SET resolved = true, resolved_at = now(),
           resolution = COALESCE(NULLIF(f.resolution,'') || ' | ','') || v_note
     WHERE NOT COALESCE(f.resolved,false)
       AND f.id = (NEW.metadata->>'alert_id')::uuid;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  BEGIN
    INSERT INTO public.ca_incident_file_failures
      (source, dedupe_key, classification, severity, discrepancy, sqlstate, message)
    VALUES ('fn_ca_incident_resolution_reaches_the_alerts',
            'propagate:incident->alert:' || NEW.id::text,
            'unknown', 'warning', 0, v_state,
            'a resolved incident did not close the alerts echoing it: ' || v_msg);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RAISE WARNING 'fn_ca_incident_resolution_reaches_the_alerts failed: %', v_msg;
  RETURN NEW;
END $function$;

-- ---------------------------------------------------------------------------
-- 4. The tick retires on silence, and says so in those words.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_incident_escalation_tick()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  inc RECORD;
  age_min numeric;
  v_sla numeric;
  v_auto int := 0;
BEGIN
  /* PHASE 6.3 (2026-09-05): AUTO-RESOLVE ON CLEAR. A detector registered with
     auto_resolve_hours names a transient finding (an hour's drift, a refused
     leg, a shadow disagreement): if the same dedupe_key has not been seen
     again for that long, the finding cleared itself and the row says so.
     A finding that keeps recurring keeps its last_seen_at fresh and stays open.

     2026-09-20: "IT CLEARED ITSELF" IS A GUESS, SO IT IS NAMED AS ONE.
     This branch used to write status='resolved' with
     correction_ref = 'verified: not seen again for N hours', and its comment
     said "the detector kept running". For a POLLING detector that is true, and
     fn_ca_resolve_cleared_incidents closes those properly on two recorded
     clean runs. For an EVENT MIRROR - financial_alerts and
     ledger_reconcile_log copied onto the board by their triggers - there is no
     detector still running: a quiet stream means only that nothing was
     written, which happens both when a defect is fixed and when the writer
     dies. Law 10.86 rule 1: that outcome is "I could not tell", it gets its own
     name, and it never borrows the word "verified". */
  WITH aged AS (
    UPDATE public.ca_drift_incidents i
       SET status        = 'resolved',
           closure_basis = 'aged_out_unverified',
           resolved_at   = now(),
           resolution    = format(
             'AGED OUT - NOT VERIFIED. This finding was last reported at %s and has not been '
             'reported again for %s hours, which is the quiet window measured for %s '
             '(ca_detector_registry.auto_resolve_hours, derived as 3x the source''s own p99 '
             'inter-arrival gap, floored at 24h). NOTHING WAS RE-MEASURED AND NO CHIPS MOVED. '
             'A silent stream is not proof the condition was fixed - it is equally what a dead '
             'writer looks like. This row is cleared off the board so the board keeps meaning '
             'something; if the condition is still live it will be filed again as a fresh '
             'incident the next time it is reported.',
             to_char(COALESCE(i.last_seen_at, i.detected_at), 'YYYY-MM-DD HH24:MI:SS UTC'),
             r.auto_resolve_hours, i.source),
           root_cause    = CASE
             WHEN length(btrim(coalesce(i.root_cause,''))) >= 40 THEN i.root_cause
             ELSE 'Never established. This incident was retired because its source stopped '
                  'reporting it, not because anyone found out what was wrong. If it matters, '
                  'the evidence is in ca_incident_events and in the source stream behind it.'
             END,
           correction_ref = format(
             'aged-out: %s stopped reporting this for %s hours (last seen %s); not re-measured',
             i.source, r.auto_resolve_hours,
             to_char(COALESCE(i.last_seen_at, i.detected_at), 'YYYY-MM-DD HH24:MI:SS'))
      FROM public.ca_detector_registry r
     WHERE r.source = i.source AND r.status = 'active' AND r.auto_resolve_hours IS NOT NULL
       AND i.status IN ('open','acknowledged','reconciling')
       AND COALESCE(i.last_seen_at, i.detected_at) < now() - make_interval(hours => r.auto_resolve_hours)
    RETURNING i.id, i.source, i.severity, i.dedupe_key, i.occurrences,
              COALESCE(i.last_seen_at, i.detected_at) AS last_seen,
              r.auto_resolve_hours AS window_hours
  )
  INSERT INTO public.ca_incident_events (incident_id, kind, actor_label, detail)
  SELECT a.id, 'status_change', 'ca-incident-escalation-tick',
         jsonb_build_object(
           'note', 'aged out, not verified: no report for ' || a.window_hours
                   || 'h (ca_detector_registry.auto_resolve_hours). Nothing was re-measured.',
           'closure_basis', 'aged_out_unverified',
           'source', a.source, 'severity', a.severity, 'dedupe_key', a.dedupe_key,
           'occurrences_at_close', a.occurrences,
           'last_seen_at', a.last_seen, 'quiet_window_hours', a.window_hours)
    FROM aged a;
  GET DIAGNOSTICS v_auto = ROW_COUNT;

  FOR inc IN
    SELECT * FROM public.ca_drift_incidents
     WHERE status IN ('open','acknowledged','reconciling')
       AND severity IN ('critical','warning')
     ORDER BY detected_at
     LIMIT 200
  LOOP
    age_min := extract(epoch FROM now() - inc.detected_at) / 60;
    -- ONE PUSH PER DRIFT (Dan, 2026-09-01): the raise already pushed; this
    -- tick now only keeps the dashboard's clock honest. escalation_level
    -- advances silently so the age is visible at a glance.
    -- PHASE 6.3 (2026-09-05): past_target is the detector's own SLA
    -- (ca_detector_registry.sla_hours, default 24h), not a flat 20 minutes.
    SELECT COALESCE(r.sla_hours, 24) INTO v_sla FROM public.ca_detector_registry r WHERE r.source = inc.source;
    v_sla := COALESCE(v_sla, 24);
    IF age_min >= v_sla * 60 AND inc.past_target IS NOT TRUE THEN
      UPDATE public.ca_drift_incidents
         SET escalation_level = GREATEST(escalation_level, 4), past_target = true
       WHERE id = inc.id;
    ELSIF age_min >= 15 AND inc.escalation_level < 3 THEN
      UPDATE public.ca_drift_incidents SET escalation_level = 3 WHERE id = inc.id;
    ELSIF age_min >= 10 AND inc.escalation_level < 2 THEN
      UPDATE public.ca_drift_incidents SET escalation_level = 2 WHERE id = inc.id;
    ELSIF age_min >= 5 AND inc.escalation_level < 1 THEN
      UPDATE public.ca_drift_incidents SET escalation_level = 1 WHERE id = inc.id;
    END IF;
  END LOOP;
  RETURN v_auto;
END $function$;

-- ---------------------------------------------------------------------------
-- 5. A re-measured closure says which kind it is, too.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_resolve_cleared_incidents()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  d          record;
  v_second   timestamptz;
  v_last     timestamptz;
  v_closed   int := 0;
  v_total    int := 0;
  v_out      jsonb := '[]'::jsonb;
  v_actor    uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid;
BEGIN
  /* WHAT MAY BE ON THIS LIST. Only a detector whose raise condition looks
     at the whole standing state, so that not raising a finding means the
     finding is gone. fn_ca_quick_reconcile is deliberately absent: it looks
     at a ten minute window, so its silence means the window moved on, not
     that anything was fixed, and auto-closing its criticals would bury real
     unanswered money.
     fn_ca_money_rpc_drift joined on 2026-09-11: it reads every row of
     pg_proc on every run, so a name it stops reporting is registered or
     gone. Before it recorded a run, a dropped function left an incident
     open forever.
     2026-09-20: these closures now stamp closure_basis='verified_remeasured'.
     THIS is the branch that earned the word "verified" - a detector ran twice
     and did not report the finding either time. The escalation tick's
     silence-based retirement is a different outcome and is recorded as
     'aged_out_unverified'; the two must never be read as the same thing. */
  FOR d IN SELECT unnest(ARRAY['fn_ca_conservation_sweep','fn_ca_ratchet_watch','fn_bbj_reconcile','fn_ca_money_rpc_drift']) AS detector
  LOOP
    SELECT ran_at INTO v_last
      FROM public.ca_detector_runs WHERE detector = d.detector
     ORDER BY ran_at DESC LIMIT 1;
    SELECT ran_at INTO v_second
      FROM public.ca_detector_runs WHERE detector = d.detector
     ORDER BY ran_at DESC OFFSET 1 LIMIT 1;

    IF v_second IS NULL THEN
      v_out := v_out || jsonb_build_object('detector', d.detector,
                 'closed', 0, 'why', 'fewer than two recorded runs so far');
      CONTINUE;
    END IF;

    UPDATE public.ca_drift_incidents i
       SET status         = 'resolved',
           closure_basis  = 'verified_remeasured',
           resolved_at    = now(),
           resolved_by    = v_actor,
           root_cause     = 'the measurement that raised this stopped reporting it: '
                         || d.detector || ' completed at ' || v_second::text
                         || ' and again at ' || v_last::text
                         || ' without raising it either time, so the condition it '
                         || 'found no longer holds. Closed by the same measurement '
                         || 'that opened it, never by assumption.',
           correction_ref = 'verified: ' || d.detector || ' ran twice without re-raising this, '
                         || 'most recently at ' || v_last::text,
           resolution     = 'no chips moved to close this. The detector re-measured and '
                         || 'found nothing; if the condition returns, the next run raises '
                         || 'it again with a fresh incident.'
     WHERE i.resolved_at IS NULL
       AND i.source LIKE d.detector || '%'
       AND i.created_at < v_second
       AND i.last_seen_at < v_second;
    GET DIAGNOSTICS v_closed = ROW_COUNT;
    v_total := v_total + v_closed;
    v_out := v_out || jsonb_build_object('detector', d.detector, 'closed', v_closed,
               'clean_since', v_second, 'last_run', v_last);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'closed', v_total, 'detectors', v_out);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. The policy. Every number derived from that source's own measured cadence.
--
--    Method: gaps between consecutive ca_incident_events rows of kind
--    created|recurred, per source, over the trailing 11 days, measured
--    2026-09-20 18:18 UTC. hours = ceil(3 * p99_gap), floored at 24.
--
--    fn_union_treasury_selftest has 0 recorded gaps (a single occurrence), so
--    it takes the floor. The floor is what protects a source with no history.
-- ---------------------------------------------------------------------------
UPDATE public.ca_detector_registry r
   SET auto_resolve_hours = v.hours,
       note = COALESCE(NULLIF(r.note,'') || ' | ', '')
         || format('2026-09-20: retires on silence after %sh. Measured over 11 days: %s gaps, '
                   'p99 %sh; 3x p99 floored at 24h. Silence is NOT verification - the tick '
                   'closes these as closure_basis=aged_out_unverified.',
                   v.hours, v.gaps, v.p99)
  FROM (VALUES
    -- source                                                                gaps    p99h   hours
    ('financial_alerts:Tournament.atomic_finish_refused',                    14593,  0.10,     24),
    ('financial_alerts:Tournament.atomic_satellite_finish_refused',           2747,  0.19,     24),
    ('financial_alerts:Tournament.atomic_satellite_finish_outcome_unknown',      7,  3.64,     24),
    ('financial_alerts:Tournament.atomic_finish_outcome_unknown',               22, 62.81,    189),
    ('financial_alerts:postHandTasks.hand_history_failed',                   14044,  0.03,     24),
    ('financial_alerts:postHandTasks.leave_pending_failed',                     58, 46.73,    141),
    ('financial_alerts:fn_union_treasury_selftest',                              0,  0.00,     24),
    ('financial_alerts:RakeSpec.drift',                                         11, 35.60,    107),
    ('financial_alerts:ServerTableEngine.authoritative_hand_unreachable',       53, 98.57,    296),
    ('financial_alerts:union_accounting_scheduler',                             81,  7.75,     24),
    ('financial_alerts:weekly_club_accounting',                                275,  1.00,     24),
    ('ledger_reconcile_log:rake_law',                                         2063,  1.00,     24),
    ('ledger_reconcile_log:under_spec',                                       1231,  1.00,     24),
    ('ledger_reconcile_log:board_not_recorded',                                 52,  2.00,     24),
    ('ledger_reconcile_log:reconcile_ledger_nightly',                          137,  1.00,     24)
  ) AS v(source, gaps, p99, hours)
 WHERE r.source = v.source AND r.status = 'active';

-- ---------------------------------------------------------------------------
-- 7. Correct the 43 rows already retired on silence and labelled "verified".
--    Corrected forward (law 10.9): nothing is deleted, no number is tidied,
--    the rows keep their resolved_at and their history. Only the claim that
--    they were verified is withdrawn.
--
--    The BEFORE trigger does not re-validate these: OLD.status is already
--    'resolved', so fn_ca_resolution_needs_a_cause returns early. The AFTER
--    trigger does not fire either - it is AFTER UPDATE OF status, and status
--    is not in this SET list.
-- ---------------------------------------------------------------------------
UPDATE public.ca_drift_incidents
   SET closure_basis = 'aged_out_unverified',
       correction_ref = 'aged-out: ' || COALESCE(
         NULLIF(regexp_replace(correction_ref, '^verified:\s*', '', 'i'), ''),
         'retired on silence by the escalation tick before 2026-09-20'),
       resolution = resolution
         || ' | RELABELLED 2026-09-20: this row was closed because its source went quiet, and was '
         || 'recorded with the evidence prefix "verified:". It was never re-measured. The wording '
         || 'is corrected forward under law 10.86 rule 1; the closure itself stands.'
 WHERE status = 'resolved'
   AND closure_basis IS NULL
   AND resolution LIKE 'auto-resolved on clear: not seen again for%';

-- NOTE: the other 3,893 historic rows carrying a real 'verified:' prefix are
-- deliberately left with closure_basis NULL. Stamping them would be cosmetic,
-- and every UPDATE to this table fires a00_operational_source_intake, which
-- writes an OLD and a NEW snapshot per row - ~7,800 archive rows to record
-- nothing anyone asked for. NULL already means "closed before this column
-- existed"; the constraint permits it, and no reader treats NULL as aged out.

-- ---------------------------------------------------------------------------
-- 8. Drop the closer that would have lied. Reasoning in the header.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fn_ca_close_incidents_the_check_no_longer_finds();

-- ---------------------------------------------------------------------------
-- 9. POST-CHECK. Project what the next tick will retire, and refuse to land if
--    these windows would overrun the board.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_proj  int;
  v_hold  int;
  v_crit  int;
  v_relab int;
  v_conf  int;
BEGIN
  SELECT count(*) FILTER (WHERE COALESCE(i.last_seen_at, i.detected_at) <  now() - make_interval(hours => r.auto_resolve_hours)),
         count(*) FILTER (WHERE COALESCE(i.last_seen_at, i.detected_at) >= now() - make_interval(hours => r.auto_resolve_hours)),
         count(*) FILTER (WHERE i.severity = 'critical'
                            AND COALESCE(i.last_seen_at, i.detected_at) < now() - make_interval(hours => r.auto_resolve_hours))
    INTO v_proj, v_hold, v_crit
    FROM public.ca_drift_incidents i
    JOIN public.ca_detector_registry r
      ON r.source = i.source AND r.status = 'active' AND r.auto_resolve_hours IS NOT NULL
   WHERE i.status IN ('open','acknowledged','reconciling');

  SELECT count(*) INTO v_conf FROM public.ca_detector_registry
   WHERE auto_resolve_hours IS NOT NULL
     AND (source LIKE 'financial_alerts:%' OR source LIKE 'ledger_reconcile_log:%');
  IF v_conf <> 15 THEN
    RAISE EXCEPTION 'ABORT: configured % mirror sources, expected 15.', v_conf;
  END IF;

  SELECT count(*) INTO v_relab FROM public.ca_drift_incidents
   WHERE closure_basis = 'aged_out_unverified' AND status = 'resolved'
     AND resolution LIKE '%RELABELLED 2026-09-20%';

  -- Measured projection 2026-09-20 18:18 UTC: 128 out (120 critical), 42 held.
  -- A ceiling, not an equality - the board moves hourly - but if these windows
  -- would sweep most of it then one of them is wrong and nothing should land.
  IF v_proj > 150 THEN
    RAISE EXCEPTION 'ABORT: these windows would retire % incidents on the next tick; the measured projection was 128 and the ceiling is 150. A threshold is too short - re-derive before applying.', v_proj;
  END IF;

  RAISE NOTICE 'Configured 15 mirror sources. The next escalation tick will age out % incident(s) (% critical) and hold %. Relabelled % historic silence-closures. Measured baseline 2026-09-20 18:18 UTC: 128 out / 120 critical / 42 held / 43 relabelled.',
    v_proj, v_crit, v_hold, v_relab;
END $$;

COMMIT;
