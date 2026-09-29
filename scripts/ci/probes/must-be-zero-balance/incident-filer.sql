-- public.fn_ca_raise_drift_incident, byte-exact production definition read from
-- pg_get_functiondef on project kuklfnapbkmacvwxktbh, 2026-09-25. The probe
-- asserts md5(pg_get_functiondef(...)) = a6df5f2eef07aa3f606db79d93944590 after
-- installing this, so a transcription drift or a production change fails the
-- qualification instead of quietly qualifying a different filer.
--
-- It is here in full, not stubbed, because the claim "a standing must_be_zero
-- imbalance folds into ONE incident instead of storming the board" is a claim
-- about THIS function's exact-key and stable-key folds and its storm cap.
CREATE OR REPLACE FUNCTION public.fn_ca_raise_drift_incident(p_source text, p_classification text, p_severity text, p_dedupe_key text, p_discrepancy numeric DEFAULT NULL::numeric, p_expected numeric DEFAULT NULL::numeric, p_actual numeric DEFAULT NULL::numeric, p_layer text DEFAULT NULL::text, p_entity_type text DEFAULT NULL::text, p_entity_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_union_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_tournament_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_settlement_id text DEFAULT NULL::text, p_wallet_ids uuid[] DEFAULT NULL::uuid[], p_transaction_ids uuid[] DEFAULT NULL::uuid[], p_suspected_cause text DEFAULT NULL::text, p_ledger_balanced boolean DEFAULT NULL::boolean, p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_class text := p_classification;
  v_sev   text := lower(COALESCE(p_severity,'critical'));
  v_stable text;
BEGIN
  IF NOT public.fn_ca_is_midway_scope(
    p_union_id, p_club_id, p_table_id, p_tournament_id, p_metadata
  ) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_detector_registry r WHERE r.source = p_source AND r.status = 'retired') THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.ca_detector_registry (source, owner, sla_hours, note)
  VALUES (p_source, 'unassigned', 24, 'auto-registered on first sight (Phase 6 gate); give it an owner')
  ON CONFLICT (source) DO NOTHING;

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
         expected_amount    = COALESCE(p_expected, expected_amount),
         suspected_cause    = COALESCE(p_suspected_cause, suspected_cause),
         metadata           = COALESCE(p_metadata, metadata)
   WHERE dedupe_key = p_dedupe_key AND status <> 'resolved'
   RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    INSERT INTO public.ca_incident_events (incident_id, kind, detail)
    VALUES (v_id, 'recurred', jsonb_build_object('source', p_source,
            'discrepancy', p_discrepancy));
    RETURN v_id;
  END IF;

  /* ONE STANDING CONDITION IS ONE INCIDENT (2026-09-06).
     A sweep that puts the date in its key defeats the exact-match fold above
     and files a fresh critical every run: sweep:fn_bbj_promo_bank_check:
     2026-09-02 .. -09-06, five rows, all 6705.21, one condition.

     The amount is what makes this safe. `diamond-unexplained:2026-09-02-18`
     is an hourly bucket where each bucket is a DIFFERENT event, so folding on
     the key alone would hide real ones. A standing condition re-reports the
     same number; a new event reports a new one. Same detector, same key
     without its period label, same discrepancy - then and only then is it the
     same finding said twice. */
  v_stable := public.fn_ca_stable_dedupe_key(p_dedupe_key);
  IF v_stable <> p_dedupe_key THEN
    UPDATE public.ca_drift_incidents
       SET occurrences     = occurrences + 1,
           last_seen_at    = now(),
           suspected_cause = COALESCE(p_suspected_cause, suspected_cause),
           metadata        = COALESCE(p_metadata, metadata)
     WHERE status <> 'resolved'
       AND source = p_source
       AND public.fn_ca_stable_dedupe_key(dedupe_key) = v_stable
       AND COALESCE(discrepancy_amount,0) = COALESCE(p_discrepancy,0)
     RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      INSERT INTO public.ca_incident_events (incident_id, kind, detail)
      VALUES (v_id, 'recurred', jsonb_build_object(
        'source', p_source, 'rotated_key', p_dedupe_key,
        'note', 'same condition under a new period label; folded rather than re-filed'));
      RETURN v_id;
    END IF;
  END IF;

  /* DETECTOR STORM CAP (2026-09-09). One source cannot own the board.
     Reached only after the exact-key fold and the stable-key fold above have
     both declined to absorb this finding, i.e. it really would be a NEW row. */
  IF (SELECT count(*) FROM public.ca_drift_incidents
       WHERE source = p_source AND status <> 'resolved') >= 25 THEN
    UPDATE public.ca_drift_incidents
       SET occurrences = occurrences + 1, last_seen_at = now()
     WHERE dedupe_key = 'storm:' || p_source AND status <> 'resolved'
     RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      INSERT INTO public.ca_drift_incidents (
        classification, severity, layer, source, dedupe_key,
        discrepancy_amount, suspected_cause, metadata)
      VALUES ('unknown', v_sev, COALESCE(p_layer,'unknown'), p_source,
        'storm:' || p_source, 0,
        'DETECTOR STORM: this source has 25 or more open incidents, so further findings are counted here rather than filed as new rows. See this incident''s event log for the original capped finding keys and reported discrepancies; this branch does not create a separate financial_alerts row for each finding. Fix the detector, or the condition behind it, then resolve this.',
        jsonb_build_object('storm', true, 'capped_from', p_dedupe_key))
      ON CONFLICT (dedupe_key) WHERE status <> 'resolved' DO NOTHING
      RETURNING id INTO v_id;
      IF v_id IS NULL THEN
        UPDATE public.ca_drift_incidents
           SET occurrences = occurrences + 1, last_seen_at = now()
         WHERE dedupe_key = 'storm:' || p_source AND status <> 'resolved'
         RETURNING id INTO v_id;
      END IF;
    END IF;
    IF v_id IS NOT NULL THEN
      INSERT INTO public.ca_incident_events (incident_id, kind, detail)
      VALUES (v_id, 'recurred', jsonb_build_object(
        'source', p_source, 'capped_dedupe_key', p_dedupe_key,
        'discrepancy', p_discrepancy, 'suspected_cause', p_suspected_cause,
        'note', 'counted on the storm incident: this source is over its open-incident cap'));
    END IF;
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
       SET occurrences     = occurrences + 1,
           last_seen_at    = now(),
           suspected_cause = COALESCE(p_suspected_cause, suspected_cause),
           metadata        = COALESCE(p_metadata, metadata)
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
    NULL;
  ELSIF (SELECT count(*) FROM public.ca_drift_incidents
       WHERE created_at > now() - interval '2 minutes') >= 10 THEN
    INSERT INTO public.ca_incident_events (incident_id, kind, detail)
    VALUES (v_id, 'notified', jsonb_build_object('storm_suppressed', true));
  ELSE
    PERFORM public.fn_ca_incident_notify(
      v_id, 'notified',
      to_char(COALESCE(p_discrepancy,0),'FM999999999990.00') || ' chip drift: ' || v_class,
      false);
  END IF;

  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  DECLARE v_state text; v_msg text;
  BEGIN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    RAISE WARNING 'fn_ca_raise_drift_incident(%) failed: %', p_source, v_msg;
    BEGIN
      INSERT INTO public.ca_incident_file_failures
        (source, dedupe_key, classification, severity, discrepancy, sqlstate, message)
      VALUES (p_source, p_dedupe_key, v_class, v_sev, p_discrepancy, v_state, v_msg);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RETURN NULL;
  END;
END $function$;
