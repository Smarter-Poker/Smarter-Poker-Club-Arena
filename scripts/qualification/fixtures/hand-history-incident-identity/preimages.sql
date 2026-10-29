-- Public definition readback 2026-10-29T18:09Z; no production rows or credentials.
CREATE OR REPLACE FUNCTION public.fn_ca_alert_resolution_reaches_the_incident()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_state text; v_msg text; v_storm record; v_members bigint; v_bad bigint; v_current boolean;
BEGIN
  IF NOT COALESCE(NEW.resolved,false) OR COALESCE(OLD.resolved,false) THEN
    RETURN NEW;
  END IF;
  UPDATE public.ca_drift_incidents i
     SET status      = 'resolved',
         resolved_at = GREATEST(COALESCE(NEW.resolved_at, now()), i.detected_at),
         correction_ref = COALESCE(NULLIF(i.correction_ref,''),
                                   'verified: closed with financial alert ' || NEW.id::text),
         root_cause  = COALESCE(NULLIF(i.root_cause,''),
                        'This incident is a mirror of financial alert ' || NEW.id::text
                        || ', raised by ' || COALESCE(NEW.source,'an unnamed source')
                        || '. The condition it describes was diagnosed and closed on that '
                        || 'alert; this row exists only because the alert was copied onto '
                        || 'the drift board when it was raised.'),
         resolution  = COALESCE(NULLIF(i.resolution,'') || ' | ', '')
                       || 'Closed with the financial alert it mirrors ('
                       || NEW.id::text || '): '
                       || COALESCE(NULLIF(NEW.resolution,''), 'no note given on the alert')
   WHERE i.status <> 'resolved'
     AND i.metadata->>'alert_id' ~ '^[0-9a-fA-F-]{36}$'
     AND (i.metadata->>'alert_id')::uuid = NEW.id;
  -- The same original resolution transition also owns its capped aggregate.
  -- Lock first, then read membership in a NEW command snapshot: concurrent last
  -- members must observe the predecessor commit, rather than both leave it open.
  IF NEW.source='Tournament.atomic_finish_refused' THEN
    FOR v_storm IN
      SELECT i.id,i.occurrences,i.detected_at FROM public.ca_drift_incidents i
      WHERE i.source='financial_alerts:Tournament.atomic_finish_refused'
        AND i.dedupe_key='storm:financial_alerts:Tournament.atomic_finish_refused'
        AND i.status<>'resolved' AND i.metadata->>'storm_member_version'='1'
      ORDER BY i.id FOR UPDATE
    LOOP
      SELECT count(*),count(*) FILTER(WHERE a.id IS NULL
                 OR a.source IS DISTINCT FROM NEW.source OR a.resolved IS DISTINCT FROM true),
             COALESCE(bool_or(a.id=NEW.id),false)
        INTO v_members,v_bad,v_current
        FROM public.ca_incident_events e
        LEFT JOIN public.financial_alerts a ON a.id=CASE
          WHEN jsonb_typeof(e.detail->'alert_id')='string'
            AND e.detail->>'alert_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          THEN (e.detail->>'alert_id')::uuid END
       WHERE e.incident_id=v_storm.id AND e.kind='recurred';
      IF v_members>0 AND v_members=v_storm.occurrences AND v_bad=0 AND v_current THEN
        UPDATE public.ca_drift_incidents SET status='resolved',
          resolved_at=GREATEST(now(),detected_at),
          closure_basis='verified_remeasured',
          correction_ref='verified: every exact storm member financial alert is resolved',
          root_cause='The original tournament finish refusals were resolved by their authoritative financial alert transitions. This capped incident retained their exact alert identities and every member now has a resolved financial record.',
          resolution='Closed in the last member financial alert resolution transaction after verifying all exact members exist, belong to this source and are resolved. No chips moved for incident closure.'
        WHERE id=v_storm.id AND status<>'resolved';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  /* Never roll back the resolve that triggered us - but never disappear
     either. RAISE WARNING alone is how this defect hid from its own author. */
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  BEGIN
    INSERT INTO public.ca_incident_file_failures
      (source, dedupe_key, classification, severity, discrepancy, sqlstate, message)
    VALUES ('fn_ca_alert_resolution_reaches_the_incident',
            'propagate:alert->incident:' || NEW.id::text,
            'unknown', 'warning', 0, v_state,
            'a resolved alert did not close the incident mirroring it: ' || v_msg);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RAISE WARNING 'fn_ca_alert_resolution_reaches_the_incident failed: %', v_msg;
  RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_financial_alert_to_incident()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dedupe text;
  v_echo_id uuid;
  v_severity text;
  v_shape text;
BEGIN
  IF NEW.severity <> 'critical' THEN RETURN NEW; END IF;
  IF NEW.source LIKE 'drift_incident:%' THEN RETURN NEW; END IF;

  /* A RESOLVED SETTLEMENT DOES NOT OPEN A LIVE INCIDENT (2026-09-24). A
     row inserted already resolved=true is a settlement's own proof that
     the damage it names is already fixed and restored - not a live
     condition. This trigger is AFTER INSERT ONLY, so an incident opened
     here from an already-resolved row can never close itself; it would
     sit open and re-escalate forever for something already fixed. */
  IF NEW.resolved THEN RETURN NEW; END IF;

  /* A REFUSED HAND IS A RATE, NOT AN INCIDENT (2026-09-09). */
  IF NEW.source = 'ServerTableEngine.authoritative_hand_semantic_refusal'
     OR COALESCE(NEW.context->>'error', '') LIKE '%authoritative_hand_semantic_refusal%' THEN
    RETURN NEW;
  END IF;

  /* A HANDOFF THAT NAMES ITS SUCCESSOR IS NOT AN INCIDENT (2026-09-10). */
  IF NEW.source = 'ServerTableEngine.post_commit_obligations_pending' THEN
    RETURN NEW;
  END IF;

  /* ONE CAUSE IS ONE INCIDENT (2026-09-09). The key is the SHAPE of the
     finding, not its instance. */
  v_shape := public.fn_ca_normalize_alert_text(left(NEW.message, 200))
             || '|' ||
             public.fn_ca_normalize_alert_text(left(COALESCE(NEW.context->>'error', ''), 200));

  v_dedupe := CASE
      -- A failed leave can strand this table/hand's stack obligation. Keep its
      -- exact entity; normalizing hand numbers must not merge another leave.
      WHEN NEW.source = 'postHandTasks.leave_pending_failed'
        THEN 'fa:postHandTasks.leave_pending_failed:'
          || CASE
              WHEN jsonb_typeof(NEW.context->'table_id') = 'string'
               AND (NEW.context->>'table_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
               AND jsonb_typeof(NEW.context->'hand_number') = 'number'
               AND (NEW.context->>'hand_number') ~ '^[1-9][0-9]*$'
               AND (length(NEW.context->>'hand_number') < 19
                    OR (length(NEW.context->>'hand_number') = 19
                        AND (NEW.context->>'hand_number') COLLATE "C" <= '9223372036854775807'))
              THEN 'table:' || (NEW.context->>'table_id')::uuid::text
                   || ':hand:' || (NEW.context->>'hand_number')
              ELSE 'alert:' || NEW.id::text
             END
          || ':' || md5(v_shape)
      -- A terminal refusal belongs to one tournament. Normalizing the error
      -- removes its UUID; shape-only folding then mixes different events.
      -- Without an entity, retain the original alert as its own unknown.
      WHEN NEW.source = 'Tournament.atomic_finish_refused'
        THEN 'fa:Tournament.atomic_finish_refused:'
          || COALESCE(NULLIF(lower(NEW.context->>'tournament_id'), ''),
                      'alert:' || NEW.id::text)
          || ':' || md5(v_shape)
      WHEN NEW.source ~* 'prize_credit_failed' AND NULLIF(NEW.context->>'tournament_id','') IS NOT NULL
        THEN 'fa:prize_credit_failed:' || (NEW.context->>'tournament_id')
      ELSE 'fa:' || NEW.source || ':' || md5(v_shape) END;

  SELECT i.id INTO v_echo_id FROM public.ca_drift_incidents i
   WHERE i.dedupe_key = v_dedupe AND i.status = 'resolved'
     AND i.resolved_at > now() - interval '48 hours'
     AND i.suspected_cause = left(NEW.message, 300)
   ORDER BY i.resolved_at DESC LIMIT 1;
  IF v_echo_id IS NOT NULL THEN
    UPDATE public.ca_drift_incidents SET occurrences = occurrences + 1 WHERE id = v_echo_id;
    INSERT INTO public.ca_incident_events (incident_id, at, kind, actor_label, detail)
    VALUES (v_echo_id, now(), 'comment', 'system',
            jsonb_build_object('note', 'Byte-identical echo of this resolved incident re-reported by '
              || NEW.source || '; folded without re-paging (alert ' || NEW.id || ').'));
    RETURN NEW;
  END IF;

  /* A DRIFT INCIDENT IS CRITICAL WHEN CHIPS ARE AT STAKE (2026-09-10). */
  v_severity := CASE
      WHEN NEW.source ~* 'conservation' THEN 'info'
      /* THE ENGINE ALREADY DECIDED THIS ONE (2026-09-12, incident bf4ef6e0).
         ServerTableEngineSettlement.runStep raises a financial alert ONLY when
         its moneyCritical argument is true, so every postHandTasks.* row here
         is already filtered to "this moves chips" - the five steps that move
         none (promo_playthrough, horse_rebuys, chip_continuity, horse_cashouts,
         deferred_sitouts) never arrive. Re-deciding it in SQL downgraded all of
         them, on two broken tests: a source-name scan for money words, which
         'leave_pending' fails while returning a player's whole stack to their
         wallet; and COALESCE(discrepancy, amount, 0) = 0 as proof of zero, when
         runStep writes neither key - 0 of 1,551 alerts in seven days carry one,
         so the test was unconditionally true and this branch could only ever
         return info. And info is not a colour: fn_ca_raise_drift_incident opens
         with IF p_severity = 'info' THEN NULL, so six failures across six
         tables paged nobody. When the engine asserts moves_chips in the
         context, that fact decides; absent, critical, because absent must fail
         toward being seen. Compared as text rather than cast to boolean on
         purpose: this trigger ends in EXCEPTION WHEN OTHERS ... RETURN NEW, so
         a bad cast would silently stop creating incidents rather than raise. */
      /* A HAND REFUSED FOR LOST OWNERSHIP IS A WARNING (2026-10-02). runStep
         re-reports the engine's own lease refusal - the one exempted above as
         authoritative_hand_semantic_refusal - under postHandTasks.hand_history_failed.
         The engine refused before writing (it could not prove it owns the
         table), so nothing moved; the successor commits the exact hand or it
         was never played (812 of 812 since 2026-10-01). Warning, not critical:
         it still opens, still pages, and stays an open unknown until the alert
         closes on its receipt. Exact reasons only; every other refusal and
         every other post-hand step keeps the branch below. */
      WHEN NEW.source = 'postHandTasks.hand_history_failed'
           AND split_part(COALESCE(NEW.context->>'error', ''), ')', 1)
               IN ('atomic hand commit refused (lease_proof_expired',
                   'atomic hand commit refused (hand_lease_stale')
        THEN 'warning'
      /* A BUSY FINISH LANE IS A WARNING UNTIL IT STRANDS A WINNER (2026-10-03).
         A finish the database refused BEFORE commit for a timeout or a
         deadlock moved nothing, and the next pass pays it (03f5b137: refused
         three times 15:33-15:36, paid exactly once at 15:37:02). The unpaid
         winner it could become is paged by
         fn_ca_tournament_finished_but_not_completed. Warning, not critical:
         it still opens, pages, and stays an open unknown until that detector
         closes it on the terminal receipt. Rule refusals and unknown
         outcomes keep the branch below. */
      WHEN NEW.source = 'Tournament.atomic_finish_refused'
           AND lower(COALESCE(NEW.context->>'proven_refusal', '')) IN ('true', 't', '1')
           AND lower(COALESCE(NEW.context->>'outcome_unknown', 'false')) IN ('false', 'f', '0')
           AND COALESCE(NEW.context->>'refusal_reason', '') IN ('timeout', 'deadlock')
        THEN 'warning'
      WHEN NEW.source LIKE 'postHandTasks.%'
        THEN CASE WHEN lower(COALESCE(NEW.context->>'moves_chips','true')) IN ('false','f','0')
                  THEN 'info' ELSE 'critical' END
      WHEN NEW.source LIKE 'ServerTableEngine.%'
           AND NOT (NEW.source ~* 'prize|payout|bounty|rake|treasury|guarantee|insurance|bbj|rakeback')
           AND COALESCE(NULLIF(NEW.context->>'discrepancy','')::numeric,
                        NULLIF(NEW.context->>'amount','')::numeric, 0) = 0
        THEN 'info'
      WHEN NEW.source ~* 'prize_credit_failed'
           AND NULLIF(NEW.context->>'user_id','') IS NOT NULL
           AND public.fn_ca_is_cert_account((NEW.context->>'user_id')::uuid) THEN 'info'
      ELSE 'critical' END;

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
    p_severity       => v_severity,
    p_dedupe_key     => v_dedupe,
    p_discrepancy    => COALESCE(NULLIF(NEW.context->>'discrepancy','')::numeric,
                                 NULLIF(NEW.context->>'amount','')::numeric, 0),
    p_layer          => 'ledger',
    p_club_id        => NULLIF(NEW.context->>'club_id','')::uuid,
    p_tournament_id  => NULLIF(NEW.context->>'tournament_id','')::uuid,
    p_table_id       => CASE WHEN NEW.source = 'postHandTasks.leave_pending_failed'
                            THEN CASE WHEN jsonb_typeof(NEW.context->'table_id') = 'string'
                                       AND (NEW.context->>'table_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                                      THEN (NEW.context->>'table_id')::uuid
                                      ELSE NULL::uuid END
                            ELSE NULLIF(NEW.context->>'table_id','')::uuid END,
    p_suspected_cause => left(NEW.message, 300),
    p_metadata       => COALESCE(NEW.context,'{}'::jsonb) ||
                        jsonb_build_object('alert_id', NEW.id));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_financial_alert_to_incident failed: %', SQLERRM;
  RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_normalize_alert_text(p_text text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  /* Order matters. UUIDs first (digits and hyphens), then timestamps, then
     decimals, then bare integers, then whitespace. What is left is the WORDS,
     which is what distinguishes one cause from another. */
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   lower(coalesce(p_text, '')),
                   '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
                   '<id>', 'g'),
                 '\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2}|z)?',
                 '<ts>', 'g'),
               '\d+\.\d+', '<amt>', 'g'),
             '\d+', '<n>', 'g'),
           '\s+', ' ', 'g')
$function$
;

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
  /* A FINDING RECORDS ITS CURRENCY (2026-09-29, Diamond Phase 10). A finding
     whose metadata says asset = diamonds is recorded in diamonds, and its
     alert and headline say Diamonds: the engine's DiamondCustody alerts
     (their context already carries the tag), the Diamond supply snapshot and
     the Diamond rule trigger. Every other finding is filed in chips, word for
     word as before. The headline names the rule when there is one, else the
     detector, and the Diamonds in doubt when there are any. */
  v_currency text := CASE WHEN lower(COALESCE(p_metadata->>'asset', '')) = 'diamonds'
                          THEN 'diamonds' ELSE 'club_chips' END;
  v_diamond_headline text := COALESCE('Diamond rule ' || (p_metadata->>'rule'), p_source)
    || CASE WHEN COALESCE(p_discrepancy, 0) <> 0
            THEN ': ' || to_char(p_discrepancy, 'FM999999999990') || ' Diamonds in doubt'
            ELSE ' is ' || v_sev END;
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
        jsonb_build_object('storm', true, 'capped_from', p_dedupe_key)
          || CASE WHEN p_source='financial_alerts:Tournament.atomic_finish_refused'
               THEN jsonb_build_object('storm_member_version',1) ELSE '{}'::jsonb END)
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
        'note', 'counted on the storm incident: this source is over its open-incident cap')
        || CASE WHEN p_source='financial_alerts:Tournament.atomic_finish_refused'
             THEN jsonb_build_object('alert_id',p_metadata->'alert_id') ELSE '{}'::jsonb END);
    END IF;
    RETURN v_id;
  END IF;

  INSERT INTO public.ca_drift_incidents (
    classification, severity, layer, source, dedupe_key,
    union_id, club_id, entity_type, entity_id, table_id, tournament_id,
    hand_id, settlement_id, wallet_ids, transaction_ids,
    expected_amount, actual_amount, discrepancy_amount,
    ledger_balanced, suspected_cause, metadata, currency)
  VALUES (
    v_class, v_sev, COALESCE(p_layer,'unknown'), p_source, p_dedupe_key,
    p_union_id, p_club_id, p_entity_type, p_entity_id, p_table_id, p_tournament_id,
    p_hand_id, p_settlement_id, p_wallet_ids, p_transaction_ids,
    p_expected, p_actual, COALESCE(p_discrepancy, 0),
    p_ledger_balanced, p_suspected_cause, COALESCE(p_metadata,'{}'::jsonb), v_currency)
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
      CASE WHEN v_currency = 'diamonds' THEN v_diamond_headline
           ELSE v_class || ' drift ' || COALESCE(p_discrepancy,0)::text || ' chips' END,
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
      CASE WHEN v_currency = 'diamonds' THEN v_diamond_headline
           /* A FINDING WITH NO AMOUNT IS NOT A CHIP DRIFT (2026-10-15). A
              liveness check (the knockout door, tables that cannot deal)
              files at 0.00 and is let through by fn_ca_incident_notify; its
              title named "0.00 chip drift" and hid which check fired. It is
              headlined by its detector, as a Diamond rule already is. */
           WHEN COALESCE(p_discrepancy, 0) = 0 THEN p_source || ' is ' || v_sev
           ELSE to_char(COALESCE(p_discrepancy,0),'FM999999999990.00') || ' chip drift: ' || v_class END,
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
END $function$
;
