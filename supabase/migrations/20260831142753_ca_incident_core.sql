-- Applied to production via Supabase MCP on 2026-08-31 (zero-drift directive).
-- This file is the byte-exact mirror of the applied migration.
-- ═══════════════════════════════════════════════════════════════════════════
-- ZERO-DRIFT DIRECTIVE — PART 1: MANAGEMENT INCIDENT CORE
-- (2026-08-31, Cowork session — "Military-Grade Chip Integrity")
--
-- Any detected or suspected discrepancy > 0 must:
--   1. create a management incident (ca_drift_incidents)
--   2. push-notify configured management immediately (via notifications →
--      fn_mirror_notification_to_push_outbox → push_outbox → dispatch worker)
--   3. escalate at 5 / 10 / 15 / 20 minutes, then controlled updates
--   4. begin automated reconciliation (part 6 wires the repair tick)
--   5. NEVER lock, close, or freeze any table, game, club, union, player,
--      manager, or wallet. Nothing in this file blocks a live operation.
--
-- Every notification and escalation is recorded in ca_incident_events.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Incident store ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_drift_incidents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at        timestamptz NOT NULL DEFAULT now(),
  deadline_at        timestamptz NOT NULL DEFAULT now() + interval '20 minutes',
  classification     text NOT NULL DEFAULT 'unknown'
    CHECK (classification IN (
      'ledger_imbalance','settlement_error','duplicate_payment','missing_payment',
      'projection_delay','cache_mismatch','reporting_mismatch','delayed_event',
      'duplicate_event','rounding_error','incorrect_rake','incorrect_weighted_rake',
      'incorrect_rakeback','bbj_error','treasury_error','credit_line_error',
      'cross_club_posting','cross_union_posting','unauthorized_adjustment',
      'historical_migration','unknown')),
  severity           text NOT NULL DEFAULT 'critical'
    CHECK (severity IN ('critical','warning','info')),
  layer              text NOT NULL DEFAULT 'unknown'
    CHECK (layer IN ('ledger','projection','cache','reporting','settlement','unknown')),
  status             text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','acknowledged','reconciling','resolved')),
  source             text NOT NULL,
  dedupe_key         text NOT NULL,
  union_id           uuid,
  club_id            uuid,
  entity_type        text,
  entity_id          uuid,
  table_id           uuid,
  tournament_id      uuid,
  hand_id            uuid,
  settlement_id      text,
  wallet_ids         uuid[],
  transaction_ids    uuid[],
  currency           text NOT NULL DEFAULT 'club_chips',
  expected_amount    numeric,
  actual_amount      numeric,
  discrepancy_amount numeric NOT NULL DEFAULT 0,
  ledger_balanced    boolean,
  suspected_cause    text,
  auto_repair_status text NOT NULL DEFAULT 'pending'
    CHECK (auto_repair_status IN ('pending','running','repaired','manual_needed','not_applicable')),
  escalation_level   int NOT NULL DEFAULT 0,
  past_target        boolean NOT NULL DEFAULT false,
  occurrences        int NOT NULL DEFAULT 1,
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_by    uuid,
  acknowledged_at    timestamptz,
  assigned_to        uuid,
  root_cause         text,
  correction_ref     text,
  resolution         text,
  resolved_by        uuid,
  resolved_at        timestamptz,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ca_drift_incidents_open_dedupe
  ON public.ca_drift_incidents (dedupe_key) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS ix_ca_drift_incidents_open
  ON public.ca_drift_incidents (status, detected_at DESC) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS ix_ca_drift_incidents_club
  ON public.ca_drift_incidents (club_id, detected_at DESC);

-- ── 2. Immutable incident audit trail ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_incident_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES public.ca_drift_incidents(id),
  at          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL CHECK (kind IN
    ('created','recurred','notified','escalated','status_change','repair_action',
     'comment','assigned','acknowledged','resolved','reopened','notify_failed')),
  actor       uuid,
  actor_label text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS ix_ca_incident_events_incident
  ON public.ca_incident_events (incident_id, at);

CREATE OR REPLACE FUNCTION public.fn_ca_incident_events_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ca_incident_events is append-only (audit trail)';
END $$;
DROP TRIGGER IF EXISTS trg_ca_incident_events_append_only ON public.ca_incident_events;
CREATE TRIGGER trg_ca_incident_events_append_only
  BEFORE UPDATE OR DELETE ON public.ca_incident_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_incident_events_append_only();

-- ── 3. Configured recipients ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_incident_recipients (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope        text NOT NULL DEFAULT 'platform'
    CHECK (scope IN ('platform','financial_ops','technical','union','club')),
  scope_id     uuid,
  user_id      uuid NOT NULL,
  min_severity text NOT NULL DEFAULT 'warning' CHECK (min_severity IN ('critical','warning','info')),
  senior       boolean NOT NULL DEFAULT false,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, scope_id, user_id)
);

INSERT INTO public.ca_incident_recipients (scope, user_id, min_severity, senior)
SELECT 'platform', p.id, 'warning', true
FROM public.profiles p
WHERE p.role IN ('admin','god')
ON CONFLICT (scope, scope_id, user_id) DO NOTHING;

-- ── 4. Recipient resolution ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_incident_recipient_ids(
  p_incident public.ca_drift_incidents,
  p_senior_only boolean DEFAULT false
) RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(DISTINCT uid), '{}')
  FROM (
    SELECT r.user_id AS uid
      FROM public.ca_incident_recipients r
     WHERE r.active
       AND (NOT p_senior_only OR r.senior)
       AND (r.scope IN ('platform','financial_ops','technical')
            OR (r.scope = 'union' AND r.scope_id = p_incident.union_id)
            OR (r.scope = 'club'  AND r.scope_id = p_incident.club_id))
    UNION
    SELECT cm.user_id
      FROM public.club_members cm
     WHERE p_incident.club_id IS NOT NULL
       AND cm.club_id = p_incident.club_id
       AND cm.role = 'owner'
    UNION
    SELECT u.owner_id
      FROM public.unions u
     WHERE p_incident.union_id IS NOT NULL
       AND u.id = p_incident.union_id
       AND u.owner_id IS NOT NULL
  ) t
  WHERE uid IS NOT NULL
$$;

-- ── 5. Notification sender ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_incident_notify(
  p_incident_id uuid,
  p_kind        text,
  p_headline    text,
  p_senior_only boolean DEFAULT false
) RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  inc  public.ca_drift_incidents;
  rec  uuid;
  n    int := 0;
  club_name  text;
  union_name text;
  body text;
  age_min int;
BEGIN
  SELECT * INTO inc FROM public.ca_drift_incidents WHERE id = p_incident_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT name INTO club_name  FROM public.clubs  WHERE id = inc.club_id;
  SELECT name INTO union_name FROM public.unions WHERE id = inc.union_id;
  age_min := GREATEST(0, floor(extract(epoch FROM now() - inc.detected_at) / 60))::int;

  body := format(
    '%s | %s drift %s chips (%s layer). Expected %s, actual %s. %s%sAge %smin, reconcile target %s. Auto-repair: %s.',
    upper(inc.severity),
    inc.classification,
    to_char(COALESCE(inc.discrepancy_amount,0), 'FM999999999990.00'),
    inc.layer,
    COALESCE(to_char(inc.expected_amount,'FM999999999990.00'),'?'),
    COALESCE(to_char(inc.actual_amount,'FM999999999990.00'),'?'),
    COALESCE('Club ' || club_name || '. ', ''),
    COALESCE('Union ' || union_name || '. ', ''),
    age_min,
    to_char(inc.deadline_at, 'HH24:MI UTC'),
    inc.auto_repair_status
  );

  FOR rec IN SELECT unnest(public.fn_ca_incident_recipient_ids(inc, p_senior_only))
  LOOP
    BEGIN
      PERFORM public.fn_raise_notification(
        rec,
        'financial_incident',
        left(p_headline, 110),
        left(body, 480),
        '/hub/club-arena/financial-incidents?id=' || inc.id::text,
        jsonb_build_object(
          'incident_id', inc.id,
          'classification', inc.classification,
          'severity', inc.severity,
          'discrepancy', inc.discrepancy_amount,
          'club_id', inc.club_id,
          'union_id', inc.union_id,
          'deadline_at', inc.deadline_at
        )
      );
      n := n + 1;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.ca_incident_events (incident_id, kind, detail)
      VALUES (inc.id, 'notify_failed',
              jsonb_build_object('recipient', rec, 'error', SQLERRM));
    END;
  END LOOP;

  INSERT INTO public.ca_incident_events (incident_id, kind, detail)
  VALUES (inc.id, p_kind,
          jsonb_build_object('headline', p_headline, 'recipients', n,
                             'senior_only', p_senior_only, 'age_min', age_min));
  RETURN n;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_incident_notify failed for %: %', p_incident_id, SQLERRM;
  RETURN 0;
END $$;

-- ── 6. Raise (or bump) an incident ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_raise_drift_incident(
  p_source         text,
  p_classification text,
  p_severity       text,
  p_dedupe_key     text,
  p_discrepancy    numeric,
  p_expected       numeric DEFAULT NULL,
  p_actual         numeric DEFAULT NULL,
  p_layer          text DEFAULT 'unknown',
  p_entity_type    text DEFAULT NULL,
  p_entity_id      uuid DEFAULT NULL,
  p_club_id        uuid DEFAULT NULL,
  p_union_id       uuid DEFAULT NULL,
  p_table_id       uuid DEFAULT NULL,
  p_tournament_id  uuid DEFAULT NULL,
  p_hand_id        uuid DEFAULT NULL,
  p_settlement_id  text DEFAULT NULL,
  p_wallet_ids     uuid[] DEFAULT NULL,
  p_transaction_ids uuid[] DEFAULT NULL,
  p_suspected_cause text DEFAULT NULL,
  p_ledger_balanced boolean DEFAULT NULL,
  p_metadata       jsonb DEFAULT '{}'::jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
  v_class text := p_classification;
  v_sev   text := lower(COALESCE(p_severity,'critical'));
BEGIN
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

  IF (SELECT count(*) FROM public.ca_drift_incidents
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
  RAISE WARNING 'fn_ca_raise_drift_incident(%) failed: %', p_source, SQLERRM;
  RETURN NULL;
END $$;

-- ── 7. Escalation tick ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_incident_escalation_tick()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  inc RECORD;
  age_min numeric;
  sent int := 0;
  budget int := 40;
BEGIN
  FOR inc IN
    SELECT * FROM public.ca_drift_incidents
     WHERE status IN ('open','acknowledged','reconciling')
     ORDER BY detected_at
     LIMIT 200
  LOOP
    EXIT WHEN budget <= 0;
    age_min := extract(epoch FROM now() - inc.detected_at) / 60;

    IF age_min >= 5 AND inc.escalation_level < 1 THEN
      UPDATE public.ca_drift_incidents SET escalation_level = 1 WHERE id = inc.id;
      PERFORM public.fn_ca_incident_notify(inc.id, 'escalated',
        '⏱ 5-min update: ' || inc.classification || ' unresolved', false);
      budget := budget - 1; sent := sent + 1;

    ELSIF age_min >= 10 AND inc.escalation_level < 2 THEN
      UPDATE public.ca_drift_incidents SET escalation_level = 2 WHERE id = inc.id;
      PERFORM public.fn_ca_incident_notify(inc.id, 'escalated',
        '🔺 10-min escalation to senior mgmt: ' || inc.classification, true);
      budget := budget - 1; sent := sent + 1;

    ELSIF age_min >= 15 AND inc.escalation_level < 3 THEN
      UPDATE public.ca_drift_incidents SET escalation_level = 3 WHERE id = inc.id;
      PERFORM public.fn_ca_incident_notify(inc.id, 'escalated',
        '⚠️ 15-min FINAL WARNING before reconcile target: ' || inc.classification, false);
      budget := budget - 1; sent := sent + 1;

    ELSIF age_min >= 20 AND inc.escalation_level < 4 THEN
      UPDATE public.ca_drift_incidents
         SET escalation_level = 4, past_target = true WHERE id = inc.id;
      PERFORM public.fn_ca_incident_notify(inc.id, 'escalated',
        '🔴 PAST 20-MIN TARGET: ' || inc.classification || ' still unresolved', false);
      budget := budget - 1; sent := sent + 1;

    ELSIF inc.escalation_level >= 4
          AND age_min >= 20 + (inc.escalation_level - 3) * 15 THEN
      UPDATE public.ca_drift_incidents
         SET escalation_level = inc.escalation_level + 1 WHERE id = inc.id;
      PERFORM public.fn_ca_incident_notify(inc.id, 'escalated',
        '🔴 Still past target (' || floor(age_min)::int || 'min): ' || inc.classification,
        true);
      budget := budget - 1; sent := sent + 1;
    END IF;
  END LOOP;
  RETURN sent;
END $$;

-- ── 8. Management actions ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_incident_action(
  p_incident_id uuid,
  p_action      text,
  p_note        text DEFAULT NULL,
  p_assignee    uuid DEFAULT NULL,
  p_root_cause  text DEFAULT NULL,
  p_correction_ref text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  inc public.ca_drift_incidents;
  v_allowed boolean;
BEGIN
  SELECT * INTO inc FROM public.ca_drift_incidents WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;

  v_allowed := v_uid IS NULL OR v_uid = ANY (public.fn_ca_incident_recipient_ids(inc, false));
  IF NOT v_allowed THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  IF p_action = 'acknowledge' THEN
    UPDATE public.ca_drift_incidents
       SET status = CASE WHEN status = 'open' THEN 'acknowledged' ELSE status END,
           acknowledged_by = COALESCE(acknowledged_by, v_uid),
           acknowledged_at = COALESCE(acknowledged_at, now())
     WHERE id = p_incident_id;
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'acknowledged', v_uid, jsonb_build_object('note', p_note));

  ELSIF p_action = 'assign' THEN
    UPDATE public.ca_drift_incidents SET assigned_to = p_assignee WHERE id = p_incident_id;
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'assigned', v_uid,
            jsonb_build_object('assignee', p_assignee, 'note', p_note));

  ELSIF p_action = 'comment' THEN
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'comment', v_uid, jsonb_build_object('note', p_note));

  ELSIF p_action = 'reconciling' THEN
    UPDATE public.ca_drift_incidents SET status = 'reconciling' WHERE id = p_incident_id;
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'status_change', v_uid,
            jsonb_build_object('to', 'reconciling', 'note', p_note));

  ELSIF p_action = 'resolve' THEN
    IF inc.classification = 'unknown'
       AND COALESCE(p_root_cause, inc.root_cause) IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'root_cause_required_for_unknown');
    END IF;
    UPDATE public.ca_drift_incidents
       SET status = 'resolved', resolved_by = v_uid, resolved_at = now(),
           resolution = COALESCE(p_note, resolution),
           root_cause = COALESCE(p_root_cause, root_cause),
           correction_ref = COALESCE(p_correction_ref, correction_ref)
     WHERE id = p_incident_id;
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'resolved', v_uid,
            jsonb_build_object('note', p_note, 'root_cause', p_root_cause,
                               'correction_ref', p_correction_ref));
    PERFORM public.fn_ca_incident_notify(p_incident_id, 'notified',
      '✅ Resolved: ' || inc.classification || ' drift', false);

  ELSIF p_action = 'reopen' THEN
    UPDATE public.ca_drift_incidents
       SET status = 'open', resolved_at = NULL, resolved_by = NULL,
           past_target = false, escalation_level = 0,
           detected_at = now(), deadline_at = now() + interval '20 minutes'
     WHERE id = p_incident_id;
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'reopened', v_uid, jsonb_build_object('note', p_note));
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_action');
  END IF;

  RETURN jsonb_build_object('ok', true);
END $$;

-- ── 9. Dashboard read RPC (management-gated) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_incident_dashboard(
  p_status text DEFAULT NULL,
  p_limit  int DEFAULT 100
) RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_mgmt boolean;
BEGIN
  IF v_uid IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.ca_incident_recipients r WHERE r.user_id = v_uid AND r.active
      UNION ALL
      SELECT 1 FROM public.club_members cm WHERE cm.user_id = v_uid AND cm.role = 'owner'
      UNION ALL
      SELECT 1 FROM public.unions u WHERE u.owner_id = v_uid
      UNION ALL
      SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.role IN ('admin','god')
    ) INTO v_mgmt;
    IF NOT v_mgmt THEN RETURN; END IF;
  END IF;
  RETURN QUERY
  SELECT to_jsonb(i) ||
         jsonb_build_object(
           'club_name',  (SELECT name FROM public.clubs  c WHERE c.id = i.club_id),
           'union_name', (SELECT name FROM public.unions u WHERE u.id = i.union_id),
           'age_minutes', floor(extract(epoch FROM now() - i.detected_at)/60),
           'events', (SELECT COALESCE(jsonb_agg(to_jsonb(e)), '[]'::jsonb)
                        FROM (SELECT at, kind, actor, detail
                                FROM public.ca_incident_events e2
                               WHERE e2.incident_id = i.id
                               ORDER BY at DESC LIMIT 30) e))
  FROM public.ca_drift_incidents i
  WHERE CASE WHEN p_status IS NULL THEN i.status <> 'resolved'
             ELSE i.status = p_status END
  ORDER BY i.detected_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit,100),1), 500);
END $$;

-- ── 10. Wire existing detectors into incidents ─────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_reconcile_log_to_incident()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_class text;
  v_layer text;
  v_club uuid;
BEGIN
  IF NEW.severity NOT IN ('warn','critical') THEN RETURN NEW; END IF;

  v_class := CASE NEW.entity_type
    WHEN 'club_treasury'          THEN 'treasury_error'
    WHEN 'frozen_wallets_pool'    THEN 'unauthorized_adjustment'
    WHEN 'seat_stack_exit'        THEN 'missing_payment'
    WHEN 'negative_balance'       THEN 'ledger_imbalance'
    WHEN 'insurance_bank'         THEN 'settlement_error'
    WHEN 'insurance_offer_unresolved' THEN 'settlement_error'
    WHEN 'cashout_escrow_stuck'   THEN 'settlement_error'
    WHEN 'over_claimed_send'      THEN 'duplicate_payment'
    WHEN 'bomb_award_ledger_gap'  THEN 'reporting_mismatch'
    ELSE 'unknown' END;
  v_layer := CASE NEW.entity_type
    WHEN 'bomb_award_ledger_gap' THEN 'reporting'
    ELSE 'ledger' END;
  BEGIN
    v_club := NULLIF(NEW.metadata->>'club_id','')::uuid;
  EXCEPTION WHEN OTHERS THEN v_club := NULL; END;
  IF v_club IS NULL AND NEW.entity_type = 'club_treasury' THEN
    v_club := NEW.entity_id;
  END IF;

  PERFORM public.fn_ca_raise_drift_incident(
    p_source          => 'ledger_reconcile_log:' || COALESCE(NEW.metadata->>'source','?'),
    p_classification  => v_class,
    p_severity        => CASE NEW.severity WHEN 'critical' THEN 'critical' ELSE 'warning' END,
    p_dedupe_key      => 'lrl:' || NEW.entity_type || ':' || COALESCE(NEW.entity_id::text,'-')
                          || ':' || COALESCE(NEW.metadata->>'exit_id',
                                             NEW.metadata->>'hand_history_id',
                                             NEW.metadata->>'escrow_id', ''),
    p_discrepancy     => COALESCE(NEW.stored_balance,0) - COALESCE(NEW.ledger_balance,0),
    p_expected        => NEW.ledger_balance,
    p_actual          => NEW.stored_balance,
    p_layer           => v_layer,
    p_entity_type     => NEW.entity_type,
    p_entity_id       => NEW.entity_id,
    p_club_id         => v_club,
    p_suspected_cause => NEW.metadata->>'rule',
    p_metadata        => COALESCE(NEW.metadata,'{}'::jsonb));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_reconcile_log_to_incident failed: %', SQLERRM;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_ca_reconcile_log_incident ON public.ledger_reconcile_log;
CREATE TRIGGER trg_ca_reconcile_log_incident
  AFTER INSERT ON public.ledger_reconcile_log
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_reconcile_log_to_incident();

CREATE OR REPLACE FUNCTION public.fn_ca_financial_alert_to_incident()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.severity <> 'critical' THEN RETURN NEW; END IF;
  IF NEW.source LIKE 'drift_incident:%' THEN RETURN NEW; END IF;
  PERFORM public.fn_ca_raise_drift_incident(
    p_source         => 'financial_alerts:' || NEW.source,
    p_classification => CASE
        WHEN NEW.source ~* 'rake'                   THEN 'incorrect_rake'
        WHEN NEW.source ~* 'bbj'                    THEN 'bbj_error'
        WHEN NEW.source ~* 'rakeback'               THEN 'incorrect_rakeback'
        WHEN NEW.source ~* 'treasury|guarantee'     THEN 'treasury_error'
        WHEN NEW.source ~* 'payout|prize|bounty'    THEN 'settlement_error'
        WHEN NEW.source ~* 'insurance'              THEN 'settlement_error'
        WHEN NEW.source ~* 'conservation'           THEN 'ledger_imbalance'
        ELSE 'unknown' END,
    p_severity       => 'critical',
    p_dedupe_key     => 'fa:' || NEW.source || ':' || md5(left(NEW.message, 200)),
    p_discrepancy    => COALESCE(NULLIF(NEW.context->>'discrepancy','')::numeric,
                                 NULLIF(NEW.context->>'amount','')::numeric, 0),
    p_layer          => 'ledger',
    p_club_id        => NULLIF(NEW.context->>'club_id','')::uuid,
    p_tournament_id  => NULLIF(NEW.context->>'tournament_id','')::uuid,
    p_table_id       => NULLIF(NEW.context->>'table_id','')::uuid,
    p_suspected_cause => left(NEW.message, 300),
    p_metadata       => COALESCE(NEW.context,'{}'::jsonb) ||
                        jsonb_build_object('alert_id', NEW.id));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_financial_alert_to_incident failed: %', SQLERRM;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_ca_financial_alert_incident ON public.financial_alerts;
CREATE TRIGGER trg_ca_financial_alert_incident
  AFTER INSERT ON public.financial_alerts
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_financial_alert_to_incident();

-- ── 11. RLS + grants ────────────────────────────────────────────────────────
ALTER TABLE public.ca_drift_incidents    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_incident_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_incident_recipients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_drift_incidents, public.ca_incident_events,
           public.ca_incident_recipients FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_incident_escalation_tick() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_incident_notify(uuid,text,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_incident_action(uuid,text,text,uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_incident_dashboard(text,int) TO authenticated;

-- ── 12. Cron: escalation heartbeat every minute ────────────────────────────
SELECT cron.schedule(
  'ca-incident-escalation-tick',
  '* * * * *',
  $cron$
    SELECT CASE
      WHEN pg_try_advisory_lock(hashtext('ca-incident-escalation-tick'))
      THEN (SELECT public.fn_ca_incident_escalation_tick())
      ELSE -1 END;
  $cron$);