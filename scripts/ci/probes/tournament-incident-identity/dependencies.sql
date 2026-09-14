CREATE OR REPLACE FUNCTION public.fn_ca_alert_resolution_reaches_the_incident()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_state text; v_msg text;
BEGIN
  IF NOT COALESCE(NEW.resolved,false) OR COALESCE(OLD.resolved,false) THEN
    RETURN NEW;
  END IF;
  UPDATE public.ca_drift_incidents i
     SET status      = 'resolved',
         resolved_at = COALESCE(NEW.resolved_at, now()),
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
        'DETECTOR STORM: this source has 25 or more open incidents, so further findings are counted here rather than filed as new rows. Every occurrence is still in financial_alerts and in this incident event log. Fix the detector, or the condition behind it, then resolve this.',
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
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_incident_notify(p_incident_id uuid, p_kind text, p_headline text, p_senior_only boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  inc  public.ca_drift_incidents;
  rec  uuid;
  n    int := 0;
  club_name  text;
  union_name text;
  body text;
  age_min int;
  v_finding text;
  v_state   text;
  v_kind    text;
  v_fresh   boolean;
  v_withheld text := NULL;
  v_findings numeric;
  /* A LIVENESS FINDING CARRIES NO CHIP AMOUNT AND STILL MATTERS (2026-09-12).
     These detectors answer "is the platform dealing", not "do the chips add
     up", so their discrepancy is always 0.00 and the money gate below would
     mute every one of them. On 2026-09-12 the engine dealt zero tournament
     hands for five hours and every detector that could have said so would have
     been filed and muted here. Measured before changing it: 1,041 pushes were
     withheld on that gate in seven days and exactly 10 were liveness findings,
     so relaxing it generally would have sent a thousand pages a week. Named
     explicitly so a future detector has to ask to be on this list, and so the
     rule that decides who gets woken is readable in one glance. */
  v_liveness CONSTANT text[] := ARRAY[
    'fn_ca_conservation_sweep:fn_ca_orphaned_running_tournaments',
    'fn_ca_conservation_sweep:fn_ca_tables_that_cannot_deal',
    'fn_ca_conservation_sweep:fn_ca_knockout_door_stalled',
    'fn_ca_conservation_sweep:fn_ca_stranded_completing_tournaments',
    'fn_ca_conservation_sweep:fn_ca_rake_rollup_writer_silent',
    'fn_ca_conservation_sweep:fn_ca_absent_tournament_players'
  ];
  v_is_liveness boolean;
BEGIN
  SELECT * INTO inc FROM public.ca_drift_incidents WHERE id = p_incident_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  v_kind := CASE
              WHEN p_kind = 'escalated'    THEN 'escalated'
              WHEN inc.status = 'resolved' THEN 'resolved'
              ELSE 'raised'
            END;

  v_is_liveness := COALESCE(inc.source, '') = ANY (v_liveness);
  v_findings := COALESCE(
      NULLIF(inc.metadata->>'row_count','')::numeric,
      jsonb_array_length(COALESCE(inc.metadata->'rows','[]'::jsonb))::numeric,
      0);

  /* DAN'S RULE, 2026-09-06. Three gates, on the PUSH only. The incident is
     still filed, the event row is still written, the board still shows
     everything - what changes is whose night it interrupts.

     Order matters: 'resolved' is checked first because a fix is the case he
     named explicitly, and it would otherwise slip through on a critical. */
  IF v_kind = 'resolved' THEN
    v_withheld := 'a fix is not a page';
  ELSIF lower(COALESCE(inc.severity,'')) <> 'critical' THEN
    v_withheld := 'severity ' || COALESCE(inc.severity,'null') || ' is not critical';
  ELSIF COALESCE(inc.discrepancy_amount, 0) = 0 AND NOT v_is_liveness THEN
    v_withheld := 'nothing is unaccounted for (0.00)';
  ELSIF COALESCE(inc.discrepancy_amount, 0) = 0 AND v_is_liveness AND v_findings = 0 THEN
    /* A liveness detector that found nothing is the healthy case and is not a
       page either. Only a detector that actually found something gets through. */
    v_withheld := 'the check is live and found nothing';
  END IF;

  IF v_withheld IS NOT NULL THEN
    INSERT INTO public.ca_incident_events (incident_id, kind, detail)
    VALUES (inc.id, 'notify_withheld',
            jsonb_build_object('reason', v_withheld, 'kind', v_kind,
                               'severity', inc.severity,
                               'discrepancy', inc.discrepancy_amount,
                               'headline', left(p_headline, 110),
                               'rule', 'Dan 2026-09-06: only critical errors that need my attention'));
    RETURN 0;
  END IF;

  SELECT name INTO club_name  FROM public.clubs  WHERE id = inc.club_id;
  SELECT name INTO union_name FROM public.unions WHERE id = inc.union_id;
  age_min := GREATEST(0, floor(extract(epoch FROM now() - inc.detected_at) / 60))::int;

  IF v_is_liveness AND COALESCE(inc.discrepancy_amount, 0) = 0 THEN
    /* Say what was actually found. "drift 0.00 chips" reads as a rounding
       error, and an alert that reads like a rounding error gets ignored. */
    body := format(
      '%s | %s: %s finding(s) on the %s layer. %s%sAge %smin, reconcile target %s.',
      upper(inc.severity), inc.entity_type,
      to_char(v_findings, 'FM999999999990'),
      inc.layer,
      COALESCE('Club ' || club_name || '. ', ''),
      COALESCE('Union ' || union_name || '. ', ''),
      age_min, to_char(inc.deadline_at, 'HH24:MI UTC'));
  ELSE
    body := format(
      '%s | %s drift %s chips (%s layer). Expected %s, actual %s. %s%sAge %smin, reconcile target %s. Auto-repair: %s.',
      upper(inc.severity), inc.classification,
      to_char(COALESCE(inc.discrepancy_amount,0), 'FM999999999990.00'),
      inc.layer,
      COALESCE(to_char(inc.expected_amount,'FM999999999990.00'),'?'),
      COALESCE(to_char(inc.actual_amount,'FM999999999990.00'),'?'),
      COALESCE('Club ' || club_name || '. ', ''),
      COALESCE('Union ' || union_name || '. ', ''),
      age_min, to_char(inc.deadline_at, 'HH24:MI UTC'), inc.auto_repair_status);
  END IF;

  v_finding := public.fn_ca_finding_key(inc.dedupe_key, inc.classification, inc.layer,
                                        inc.club_id, inc.union_id);
  v_state := md5(
      v_kind
      || '|' || COALESCE(inc.severity,'?')
      || '|' || COALESCE(inc.classification,'?')
      || '|' || COALESCE(inc.layer,'?')
      || '|' || COALESCE(inc.club_id::text,'-')
      || '|' || COALESCE(inc.union_id::text,'-')
      || '|' || CASE WHEN v_kind = 'escalated'
                     THEN COALESCE(inc.escalation_level, 0)::text ELSE '' END);

  FOR rec IN SELECT unnest(public.fn_ca_incident_recipient_ids(inc, p_senior_only))
  LOOP
    BEGIN
      v_fresh := NULL;
      INSERT INTO public.ca_incident_notify_ledger AS l
        (recipient_id, finding_key, state_hash, last_kind, last_incident_id)
      VALUES (rec, v_finding, v_state, v_kind, inc.id)
      ON CONFLICT (recipient_id, finding_key) DO UPDATE
        SET state_hash = EXCLUDED.state_hash, last_kind = EXCLUDED.last_kind,
            last_incident_id = EXCLUDED.last_incident_id, last_sent_at = now(),
            send_count = l.send_count + 1
        WHERE l.state_hash IS DISTINCT FROM EXCLUDED.state_hash
      RETURNING true INTO v_fresh;

      IF NOT COALESCE(v_fresh, false) THEN
        INSERT INTO public.ca_incident_events (incident_id, kind, detail)
        VALUES (inc.id, 'notified',
                jsonb_build_object('already_reported', true, 'finding_key', v_finding,
                                   'state', v_kind, 'recipient', rec));
        CONTINUE;
      END IF;

      PERFORM public.fn_raise_notification(
        rec, 'financial_incident', left(p_headline, 110), left(body, 480),
        '/hub/club-arena/financial-incidents?id=' || inc.id::text,
        jsonb_build_object('incident_id', inc.id, 'finding_key', v_finding,
                           'classification', inc.classification, 'severity', inc.severity,
                           'discrepancy', inc.discrepancy_amount, 'club_id', inc.club_id,
                           'union_id', inc.union_id, 'deadline_at', inc.deadline_at));
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
                             'senior_only', p_senior_only, 'age_min', age_min,
                             'finding_key', v_finding, 'state', v_kind));
  RETURN n;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_incident_notify failed for %: %', p_incident_id, SQLERRM;
  RETURN 0;
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_is_cert_account(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- DEFINER, like fn_ca_is_fixture_account. It reads auth.users, which `authenticated` cannot
  -- select from, so as INVOKER it answered one thing for service_role and another for everyone
  -- else - a predicate whose result depended on the caller rather than the account.
  --
  -- A HORSE IS A PLAYER (CLAUDE.md 10.5), so it is never certification equipment, whatever its
  -- address looks like. The fleet shares an email domain, which classified 468 of them as test
  -- equipment until 2026-09-08.
  SELECT p_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id AND COALESCE(p.is_horse, false))
    AND (
      EXISTS (SELECT 1 FROM public.ca_cert_accounts c WHERE c.user_id = p_user_id AND c.active)
      OR p_user_id::text LIKE '00000000-0000-0000-0000-%'
      OR EXISTS (SELECT 1 FROM auth.users u
                  WHERE u.id = p_user_id
                    AND (u.email LIKE '%@horses.smarter.poker'
                         OR u.email LIKE '%.invalid'))
    );
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_is_midway_scope(p_union_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_tournament_id uuid DEFAULT NULL::uuid, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((
    -- THE FOUR ESTATES (Dan, 2026-09-03): Midway Union with Club JAQK and
    -- SHARK CLUB inside it, and Deep Stack Society standing alone. Until
    -- chip standard Phase 4.3 (2026-09-04) this scope was Midway only, so an
    -- incident about Deep Stack Society's money - its jackpot reserve running
    -- dry, a payout that could not reconcile - was dropped before it was
    -- filed. Deep Stack is an estate; its incidents file.
    -- platform-substrate incidents: no entity dimension anywhere = global
    -- checks (supply, suspense, guards, crons, diamonds) that protect every
    -- union including Midway. These always file.
    (p_union_id IS NULL AND p_club_id IS NULL AND p_table_id IS NULL
     AND p_tournament_id IS NULL
     AND COALESCE(p_metadata->>'union_id','') = ''
     AND COALESCE(p_metadata->>'club_id','') = '')
    OR p_union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
    OR p_club_id IN ('fade0000-0000-0000-0000-000000000001'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)
    OR EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.id = p_club_id
         AND c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
    )
    OR EXISTS (
      SELECT 1 FROM public.union_clubs uc
       WHERE uc.club_id = p_club_id
         AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
    )
    OR EXISTS (
      SELECT 1 FROM public.tables t
      JOIN public.clubs c ON c.id = t.club_id
       WHERE t.id = p_table_id
         AND (
           c.id IN ('fade0000-0000-0000-0000-000000000001'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)
           OR c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR EXISTS (
             SELECT 1 FROM public.union_clubs uc
              WHERE uc.club_id = c.id
                AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           )
         )
    )
    OR EXISTS (
      SELECT 1 FROM public.tournaments t
      JOIN public.clubs c ON c.id = t.club_id
       WHERE t.id = p_tournament_id
         AND (
           c.id IN ('fade0000-0000-0000-0000-000000000001'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)
           OR c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR EXISTS (
             SELECT 1 FROM public.union_clubs uc
              WHERE uc.club_id = c.id
                AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           )
         )
    )
    OR COALESCE(p_metadata->>'union_id', '') = 'fade0000-0000-0000-0000-000000000001'
    OR EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.id::text = COALESCE(p_metadata->>'club_id', '')
         AND (
           c.id IN ('fade0000-0000-0000-0000-000000000001'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)
           OR c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR EXISTS (
             SELECT 1 FROM public.union_clubs uc
              WHERE uc.club_id = c.id
                AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           )
         )
    )), false);
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_stable_dedupe_key(p_key text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  /* Strips a trailing period label: :2026-09-06, :2026-09-06-18, :2026-36.
     Used ONLY together with an equal discrepancy, so an hourly bucket that
     reports a different number is never folded into another one. */
  SELECT regexp_replace($1, ':([0-9]{4}-[0-9]{2}-[0-9]{2}(-[0-9]{2})?|[0-9]{4}-[0-9]{1,2})$', '')
$function$
;

CREATE OR REPLACE FUNCTION public.fn_raise_server_financial_alert(p_severity text, p_source text, p_message text, p_context jsonb DEFAULT '{}'::jsonb, p_dedupe_key text DEFAULT NULL::text, p_entity_id text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id     uuid;
  v_sev    text;
  v_source text;
  v_key    text;
  v_entity text;
  v_recent integer;
BEGIN
  v_sev := lower(coalesce(p_severity, 'info'));
  IF v_sev NOT IN ('critical', 'warning', 'info') THEN
    v_sev := 'info';
  END IF;

  v_source := left(coalesce(nullif(p_source, ''), 'unknown'), 200);
  v_entity := left(nullif(btrim(coalesce(p_entity_id, '')), ''), 200);
  v_key    := left(nullif(btrim(coalesce(p_dedupe_key, '')), ''), 200);
  IF v_key IS NULL THEN
    v_key := v_entity;
  END IF;

  /* ONE OPEN ALERT PER THING THAT IS WRONG. Not per pass over it. */
  IF v_key IS NOT NULL THEN
    SELECT fa.id INTO v_id
      FROM public.financial_alerts fa
     WHERE fa.source = v_source
       AND fa.resolved IS NOT TRUE
       AND fa.context ->> 'dedupe_key' = v_key
     ORDER BY fa.created_at DESC
     LIMIT 1;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  SELECT count(*) INTO v_recent
    FROM public.financial_alerts
   WHERE created_at > now() - interval '1 minute'
     AND source = v_source
     AND context ->> 'channel' = 'server_rpc';

  IF v_recent >= 60 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.financial_alerts (severity, source, message, context, resolved)
  VALUES (
    v_sev,
    v_source,
    left(coalesce(nullif(p_message, ''), '(no message)'), 4000),
    coalesce(p_context, '{}'::jsonb)
      || jsonb_build_object('channel', 'server_rpc')
      || CASE WHEN v_key IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('dedupe_key', v_key) END
      || CASE WHEN v_entity IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('entity_id', v_entity) END,
    false
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$
;
