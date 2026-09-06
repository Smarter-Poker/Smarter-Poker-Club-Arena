-- 20260905203427_phase_6_3_every_detector_has_an_owner_an_sla_and_a_way_to_re.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard Phase 6.3, 2026-09-05 20:4x UTC):
--
-- ca_drift_incidents carried 70 distinct sources with no owner, one flat
-- 20-minute "past target" for every one of them, no way to retire a detector
-- whose finding a rule now makes impossible, and no way for a transient
-- finding to close itself. The board read as 250 open rows this morning, of
-- which the real ones were a handful; the gate closed 43 by hand.
--
-- THE ALERT BOARD: ca_detector_registry names an owner, an SLA in hours and
-- a status for every source, plus an optional clear window. Seeded from every
-- source on record, owners by the programme the source belongs to. The
-- escalation tick marks past_target at the detector's own SLA and
-- auto-resolves a transient finding not seen again within its clear window
-- (a recurring finding keeps last_seen_at fresh and stays open). A retired
-- detector files nothing (fn_ca_raise_drift_incident returns before the
-- insert), and its row says which rule made the finding impossible.
-- v_ca_alert_board is the board: per detector, open, oldest, past SLA.
--
-- RETIRED TODAY, each with the rule that makes it impossible:
--   fn_ca_settle_hand_stacks_absolute - the engine writes stacks in delta
--     mode since 09-04 19:00 (PR #2958); 65 open rows from before, resolved.
--   fn_ca_escrow_vs_counter_check as a filer - R5 is judged at close by
--     fn_ca_escrow_on_close and hourly by fn_ca_escrow_balance_drift since
--     Phase 5.1; the shadow stays callable and its 30 open rows stay open as
--     the epoch reset gate's list. The hourly cron now runs the drift check
--     alone.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE TABLE IF NOT EXISTS public.ca_detector_registry (
  source              text PRIMARY KEY,
  owner               text NOT NULL,
  sla_hours           integer NOT NULL DEFAULT 24 CHECK (sla_hours > 0),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  auto_resolve_hours  integer CHECK (auto_resolve_hours IS NULL OR auto_resolve_hours > 0),
  retired_by          text,
  note                text NOT NULL DEFAULT '',
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ca_detector_registry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_detector_registry FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_detector_registry TO service_role;
COMMENT ON TABLE public.ca_detector_registry IS 'Chip standard Phase 6.3: every ca_drift_incidents source has an owner, an SLA and a status; a retired detector files nothing; auto_resolve_hours closes a transient finding not seen again within the window.';

-- Seed: every source on record, owner by programme.
INSERT INTO public.ca_detector_registry (source, owner, sla_hours, note)
SELECT s.source,
       CASE
         WHEN s.source LIKE 'fn_ca_diamond%' THEN 'diamond programme'
         WHEN s.source LIKE 'financial_alerts:ServerTableEngine.%' OR s.source LIKE 'financial_alerts:deploy_truth.%' THEN 'engine'
         WHEN s.source LIKE 'financial_alerts:Tournament.%' OR s.source LIKE 'financial_alerts:fn_tournament%' OR s.source LIKE 'financial_alerts:fn_payout%'
              OR s.source LIKE 'financial_alerts:Satellite.%' OR s.source LIKE 'financial_alerts:fn_spin%' OR s.source LIKE 'financial_alerts:fn_settle%'
              OR s.source LIKE 'financial_alerts:fn_ca_duplicate_structure%' THEN 'tournament'
         WHEN s.source LIKE 'financial_alerts:FeeReconciler.%' OR s.source LIKE 'financial_alerts:fn_rake%' THEN 'rake'
         WHEN s.source LIKE 'financial_alerts:daily_missions%' THEN 'missions'
         WHEN s.source LIKE 'atomic_credit_wallet_and_log:%' THEN 'wallet'
         WHEN s.source LIKE 'fn_spin_%' THEN 'spins'
         WHEN s.source LIKE 'audit:%' THEN 'audit'
         ELSE 'chip standard'
       END,
       CASE WHEN s.source LIKE 'financial_alerts:ServerTableEngine.%' THEN 4 ELSE 24 END,
       'seeded at Phase 6.3 from the sources on record'
  FROM (SELECT DISTINCT source FROM public.ca_drift_incidents WHERE source IS NOT NULL) s
ON CONFLICT (source) DO NOTHING;

-- Transient detectors: a finding not seen again within the window closes itself.
UPDATE public.ca_detector_registry SET auto_resolve_hours = 24, note = note || '; transient: clears after 24h unseen'
 WHERE source IN ('fn_ca_supply_snapshot', 'fn_bbj_reconcile', 'fn_ca_escrow_balance_drift', 'fn_ca_quick_reconcile:ledger_write_failure',
                  'fn_ca_quick_reconcile:suspense_flow', 'fn_ca_quick_reconcile:frozen_pool', 'fn_ca_trial_balance_watch', 'fn_ca_suspense_regression_check',
                  'fn_ca_cron_failure_watch', 'fn_ca_mint_velocity_watch', 'fn_ca_orphaned_checks_watch', 'fn_ca_ratchet_watch');

-- Retired: the rule that makes the finding impossible is the note.
UPDATE public.ca_detector_registry
   SET status = 'retired', retired_by = 'chip standard Phase 6.3', updated_at = now(),
       note = 'retired: the engine writes stacks in delta mode since 2026-09-04 19:00 (PR #2958, the erasure detector knows delta mode); an absolute-mode finding is impossible'
 WHERE source = 'fn_ca_settle_hand_stacks_absolute';
UPDATE public.ca_detector_registry
   SET status = 'retired', retired_by = 'chip standard Phase 6.3', updated_at = now(),
       note = 'retired as a filer: R5 is judged at close by fn_ca_escrow_on_close and hourly by fn_ca_escrow_balance_drift (Phase 5.1); the shadow stays callable; its open rows are the epoch reset gate''s list'
 WHERE source = 'fn_ca_escrow_vs_counter_check';

UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(),
       correction_ref = 'migration 20260904192338_the_erasure_detector_knows_delta_mode_and_the_sweep_retires',
       root_cause = 'the detector read absolute-mode stack writes; the engine has written stacks in delta mode since 2026-09-04 19:00 and the finding is impossible since',
       resolution = 'detector retired at Phase 6.3 (ca_detector_registry); nothing to correct'
 WHERE source = 'fn_ca_settle_hand_stacks_absolute' AND status IN ('open','acknowledged','reconciling');

-- The hourly cron: the drift check alone; the shadow no longer files.
DO $$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'ca-escrow-shadow-hourly';
  IF v_id IS NULL THEN RAISE EXCEPTION 'ca-escrow-shadow-hourly is not scheduled'; END IF;
  PERFORM cron.alter_job(v_id, command => $c$ SET statement_timeout = '300s';
          SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-escrow-shadow'))
                      THEN (public.fn_ca_escrow_balance_drift(1))::text
                      ELSE 'locked' END; $c$);
END $$;

CREATE OR REPLACE FUNCTION public.fn_ca_raise_drift_incident(p_source text, p_classification text, p_severity text, p_dedupe_key text, p_discrepancy numeric, p_expected numeric DEFAULT NULL::numeric, p_actual numeric DEFAULT NULL::numeric, p_layer text DEFAULT 'unknown'::text, p_entity_type text DEFAULT NULL::text, p_entity_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_union_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_tournament_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_settlement_id text DEFAULT NULL::text, p_wallet_ids uuid[] DEFAULT NULL::uuid[], p_transaction_ids uuid[] DEFAULT NULL::uuid[], p_suspected_cause text DEFAULT NULL::text, p_ledger_balanced boolean DEFAULT NULL::boolean, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_class text := p_classification;
  v_sev   text := lower(COALESCE(p_severity,'critical'));
BEGIN
  IF NOT public.fn_ca_is_midway_scope(
    p_union_id, p_club_id, p_table_id, p_tournament_id, p_metadata
  ) THEN
    RETURN NULL;
  END IF;
  /* PHASE 6.3 (2026-09-05): a retired detector files nothing. The registry is
     data; retiring a detector is an UPDATE, not a deploy, and the retired
     row says which rule made the finding impossible. */
  IF EXISTS (SELECT 1 FROM public.ca_detector_registry r WHERE r.source = p_source AND r.status = 'retired') THEN
    RETURN NULL;
  END IF;

  IF v_class IS NULL OR v_class NOT IN (
      'ledger_imbalance','settlement_error','duplicate_payment','missing_payment',
      'projection_delay','cache_mismatch','reporting_mismatch','delayed_event',
      'duplicate_event','rounding_error','incorrect_rake','incorrect_weighted_rake',
      'incorrect_rakeback','bbj_error','treasury_error','credit_line_error',
      'cross_club_posting','cross_union_posting','unauthorized_adjustment',
      'historical_migration','unknown') THEN
    v_class := 'unknown';
  END IF;
  IF v_sev NOT IN ('critical','warning','info') THEN v_sev := 'critical'; END IF;

  UPDATE public.ca_drift_incidents
     SET occurrences  = occurrences + 1,
         last_seen_at = now(),
         discrepancy_amount = COALESCE(p_discrepancy, discrepancy_amount),
         actual_amount      = COALESCE(p_actual, actual_amount),
         expected_amount    = COALESCE(p_expected, expected_amount)
   WHERE dedupe_key = p_dedupe_key AND status <> 'resolved'
   RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    INSERT INTO public.ca_incident_events (incident_id, kind, detail)
    VALUES (v_id, 'recurred', jsonb_build_object('source', p_source,
            'discrepancy', p_discrepancy));
    RETURN v_id;
  END IF;

  INSERT INTO public.ca_drift_incidents (
    classification, severity, layer, source, dedupe_key,
    union_id, club_id, entity_type, entity_id, table_id, tournament_id,
    hand_id, settlement_id, wallet_ids, transaction_ids,
    expected_amount, actual_amount, discrepancy_amount,
    ledger_balanced, suspected_cause, metadata)
  VALUES (
    v_class, v_sev, COALESCE(p_layer,'unknown'), p_source, p_dedupe_key,
    p_union_id, p_club_id, p_entity_type, p_entity_id, p_table_id, p_tournament_id,
    p_hand_id, p_settlement_id, p_wallet_ids, p_transaction_ids,
    p_expected, p_actual, COALESCE(p_discrepancy, 0),
    p_ledger_balanced, p_suspected_cause, COALESCE(p_metadata,'{}'::jsonb))
  ON CONFLICT (dedupe_key) WHERE status <> 'resolved' DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    UPDATE public.ca_drift_incidents
       SET occurrences = occurrences + 1, last_seen_at = now()
     WHERE dedupe_key = p_dedupe_key AND status <> 'resolved'
     RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.ca_incident_events (incident_id, kind, detail)
  VALUES (v_id, 'created', jsonb_build_object('source', p_source));

  BEGIN
    PERFORM public.fn_raise_server_financial_alert(
      v_sev, 'drift_incident:' || p_source,
      v_class || ' drift ' || COALESCE(p_discrepancy,0)::text || ' chips',
      jsonb_build_object('incident_id', v_id) || COALESCE(p_metadata,'{}'::jsonb));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  IF p_severity = 'info' THEN
    -- dashboard-only by definition: record, never page
    NULL;
  ELSIF (SELECT count(*) FROM public.ca_drift_incidents
       WHERE created_at > now() - interval '2 minutes') >= 10 THEN
    INSERT INTO public.ca_incident_events (incident_id, kind, detail)
    VALUES (v_id, 'notified', jsonb_build_object('storm_suppressed', true));
  ELSE
    PERFORM public.fn_ca_incident_notify(
      v_id, 'notified',
      '🚨 Chip drift: ' || v_class || ' (' ||
        to_char(COALESCE(p_discrepancy,0),'FM999999999990.00') || ')',
      false);
  END IF;

  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  -- Still swallowed: this runs inside settlement paths and an alarm must never
  -- roll a money transaction back. What changed on 2026-09-02 is that the
  -- evidence now lands somewhere a person reads. RAISE WARNING alone goes to
  -- the Postgres log, so 901 consecutive failures caused by one bad `layer`
  -- value looked exactly like nothing being wrong.
  DECLARE v_state text; v_msg text;
  BEGIN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    RAISE WARNING 'fn_ca_raise_drift_incident(%) failed: %', p_source, v_msg;
    BEGIN
      INSERT INTO public.ca_incident_file_failures
        (source, dedupe_key, classification, severity, discrepancy, sqlstate, message)
      VALUES (p_source, p_dedupe_key, v_class, v_sev, p_discrepancy, v_state, v_msg);
    EXCEPTION WHEN OTHERS THEN
      -- The recorder itself must never be the thing that breaks a settlement.
      NULL;
    END;
    RETURN NULL;
  END;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_raise_drift_incident(text, text, text, text, numeric, numeric, numeric, text, text, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid[], uuid[], text, boolean, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_raise_drift_incident(text, text, text, text, numeric, numeric, numeric, text, text, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid[], uuid[], text, boolean, jsonb) TO service_role;

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
     again for that long, the finding cleared itself and the row says so. A
     finding that keeps recurring keeps its last_seen_at fresh and stays open. */
  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         resolution = format('auto-resolved on clear: not seen again for %s hours (ca_detector_registry.auto_resolve_hours); the detector kept running', r.auto_resolve_hours),
         root_cause = COALESCE(i.root_cause, 'transient finding that did not recur within the detector''s clear window'),
         correction_ref = COALESCE(i.correction_ref, format('verified: not seen again for %s hours by the detector that filed it (ca_detector_registry.auto_resolve_hours, Phase 6.3)', r.auto_resolve_hours))
    FROM public.ca_detector_registry r
   WHERE r.source = i.source AND r.status = 'active' AND r.auto_resolve_hours IS NOT NULL
     AND i.status IN ('open','acknowledged','reconciling')
     AND COALESCE(i.last_seen_at, i.detected_at) < now() - make_interval(hours => r.auto_resolve_hours);
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
REVOKE ALL ON FUNCTION public.fn_ca_incident_escalation_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_incident_escalation_tick() TO service_role;

CREATE OR REPLACE VIEW public.v_ca_alert_board AS
SELECT r.source, r.owner, r.status, r.sla_hours, r.auto_resolve_hours,
       count(i.id) FILTER (WHERE i.status IN ('open','acknowledged','reconciling')) AS open,
       min(i.detected_at) FILTER (WHERE i.status IN ('open','acknowledged','reconciling')) AS oldest_open_at,
       count(i.id) FILTER (WHERE i.status IN ('open','acknowledged','reconciling') AND i.detected_at < now() - make_interval(hours => r.sla_hours)) AS past_sla,
       max(i.detected_at) AS last_detected_at,
       count(i.id) FILTER (WHERE i.detected_at > now() - interval '24 hours') AS filed_24h,
       r.note
  FROM public.ca_detector_registry r
  LEFT JOIN public.ca_drift_incidents i ON i.source = r.source
 GROUP BY r.source, r.owner, r.status, r.sla_hours, r.auto_resolve_hours, r.note;
REVOKE ALL ON public.v_ca_alert_board FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_ca_alert_board TO service_role;

DO $$
DECLARE v_n int; v_open int;
BEGIN
  SELECT count(*) INTO v_n FROM public.ca_detector_registry;
  IF v_n < 60 THEN RAISE EXCEPTION 'the registry is not seeded (%)', v_n; END IF;
  SELECT count(*) INTO v_open FROM public.ca_drift_incidents WHERE source = 'fn_ca_settle_hand_stacks_absolute' AND status = 'open';
  IF v_open <> 0 THEN RAISE EXCEPTION 'absolute-mode findings still open'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_raise_drift_incident') NOT LIKE '%ca_detector_registry%' THEN RAISE EXCEPTION 'the raise does not read the registry'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_incident_escalation_tick') NOT LIKE '%auto-resolved on clear%' THEN RAISE EXCEPTION 'the tick does not auto-resolve'; END IF;
  IF (SELECT command FROM cron.job WHERE jobname = 'ca-escrow-shadow-hourly') LIKE '%fn_ca_escrow_vs_counter_check%' THEN RAISE EXCEPTION 'the shadow still files hourly'; END IF;
END $$;

COMMIT;
