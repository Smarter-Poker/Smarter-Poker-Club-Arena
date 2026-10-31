-- Reserved by scripts/new-migration.mjs. Metadata-only closure proof correction.
-- Production group4f6fc811 retained43 original events in one cron transaction;
-- all43 source alerts have that transaction timestamp and same cause key.
-- Per-event uniqueness can never prove this complete set. Preserve original
-- history and require exact source/cause/time cardinality, every alert resolved,
-- no mixed versioned bucket, and actual current-member participation.
-- No financial writes, observer schedules, alert suppression or source replay.
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_alert_resolution_reaches_the_incident()'::regprocedure))='c6b3d7c19114d3f42aeaa4a43d8d80ab'
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
DO $before$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc
  WHERE oid='public.fn_ca_alert_resolution_reaches_the_incident()'::regprocedure
  AND md5(pg_get_functiondef(oid))='6aeff3afb938b152034f9a250efb3e21'
  AND pg_get_userbyid(proowner)='postgres' AND prosecdef
  AND proconfig=ARRAY['search_path=public']::text[]
  AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
  RAISE EXCEPTION 'LEGACY_INCIDENT_BATCH_PREIMAGE_OR_AUTHORITY_CHANGED';
 END IF;
END $before$;
CREATE OR REPLACE FUNCTION public.fn_ca_alert_resolution_reaches_the_incident()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_state text; v_msg text; v_storm record; v_group record; v_members bigint; v_bad bigint; v_current boolean;
BEGIN
  IF NOT COALESCE(NEW.resolved,false) OR COALESCE(OLD.resolved,false) THEN
    RETURN NEW;
  END IF;
  -- The original raise and resolution share transaction ownership before any
  -- incident row lock. A conflict cannot resolve between DO NOTHING and fallback.
  FOR v_group IN SELECT DISTINCT i.dedupe_key FROM public.ca_drift_incidents i
    WHERE i.status<>'resolved' AND i.source='financial_alerts:' || NEW.source
      AND (i.dedupe_key='fa:' || NEW.source || ':' || md5(public.fn_ca_normalize_alert_text(left(NEW.message,200)) || '|' || public.fn_ca_normalize_alert_text(left(COALESCE(NEW.context->>'error',''),200)))
        OR i.metadata->>'alert_id'=NEW.id::text
        OR EXISTS(SELECT 1 FROM public.ca_incident_events e WHERE e.incident_id=i.id
          AND e.kind IN('created','recurred') AND lower(e.detail->>'alert_id')=NEW.id::text))
    ORDER BY i.dedupe_key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('ca-financial-incident-members:' || public.fn_ca_stable_dedupe_key(v_group.dedupe_key),0));
  END LOOP;
  -- A cause group may contain different original entities. Lock its owner row
  -- before reading membership so concurrent final resolutions see prior commits.
  FOR v_group IN SELECT i.id,i.source,i.dedupe_key,i.occurrences,i.detected_at
    FROM public.ca_drift_incidents i
    WHERE i.status <> 'resolved' AND i.source='financial_alerts:' || NEW.source
      AND i.dedupe_key='fa:' || NEW.source || ':' || md5(public.fn_ca_normalize_alert_text(left(NEW.message,200)) || '|' || public.fn_ca_normalize_alert_text(left(COALESCE(NEW.context->>'error',''),200)))
    ORDER BY i.id FOR UPDATE
  LOOP
    WITH members AS (
      SELECT e.id,e.detail,m.matches,m.current_member,m.all_resolved,
             m.legacy_event_count,m.mixed_bucket
      FROM public.ca_incident_events e
      CROSS JOIN LATERAL (
        SELECT count(*) AS matches,
               COALESCE(bool_or(a.id=NEW.id),false) AS current_member,
               bool_and(a.resolved IS TRUE) AS all_resolved,
               (SELECT count(*) FROM public.ca_incident_events le
                 WHERE le.incident_id=v_group.id AND le.at=e.at
                   AND le.kind IN ('created','recurred')
                   AND NOT(le.detail ? 'financial_member_version')) AS legacy_event_count,
               EXISTS(SELECT 1 FROM public.ca_incident_events ve
                 WHERE ve.incident_id=v_group.id AND ve.at=e.at
                   AND ve.kind IN ('created','recurred')
                   AND ve.detail ? 'financial_member_version') AS mixed_bucket
        FROM (
          SELECT a.id,a.resolved FROM public.financial_alerts a
          WHERE e.detail->'financial_member_version'='1'::jsonb
            AND jsonb_typeof(e.detail->'alert_id')='string'
            AND a.id=CASE WHEN e.detail->>'alert_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                         THEN (e.detail->>'alert_id')::uuid END
            AND a.source=NEW.source
          UNION ALL
          SELECT a.id,a.resolved FROM public.financial_alerts a
          WHERE NOT(e.detail ? 'financial_member_version')
            AND a.source=NEW.source AND a.created_at=e.at AND a.severity='critical'
            AND v_group.dedupe_key='fa:' || a.source || ':' || md5(
              public.fn_ca_normalize_alert_text(left(a.message,200)) || '|' ||
              public.fn_ca_normalize_alert_text(left(COALESCE(a.context->>'error',''),200)))
        ) a
      ) m
      WHERE e.incident_id=v_group.id AND e.kind IN ('created','recurred')
    )
    -- A legacy cron transaction can raise many originals at the same now().
    -- Individual permutation is unknown, but its complete same-source/cause/time
    -- set is proved when the alert count equals the original-event count and
    -- every member resolves. Mixed formats and missing/extra rows remain unknown.
    SELECT count(*),count(*) FILTER(WHERE matches<1
            OR (detail ? 'financial_member_version' AND matches<>1)
            OR (NOT(detail ? 'financial_member_version')
                AND (matches<>legacy_event_count OR mixed_bucket))
            OR all_resolved IS DISTINCT FROM true
            OR detail->>'source' IS DISTINCT FROM v_group.source),
           COALESCE(bool_or(current_member),false)
      INTO v_members,v_bad,v_current FROM members;
    IF v_members>0 AND v_members=v_group.occurrences AND v_bad=0 AND v_current THEN
      UPDATE public.ca_drift_incidents SET status='resolved',
        resolved_at=GREATEST(now(),detected_at),closure_basis='verified_remeasured',
        correction_ref=COALESCE(NULLIF(correction_ref,''),'verified: every exact cause-group source alert is resolved'),
        root_cause=COALESCE(NULLIF(root_cause,''),
          'This incident is a same-cause financial alert group. Every exact original source alert or complete legacy transaction set is resolved. Typed entity fields retain the first witness; metadata retains the latest witness.'),
        resolution=COALESCE(NULLIF(resolution,'') || ' | ','') ||
          'Verified all ' || v_members || ' exact original source alert members resolved; the final original transition was ' || NEW.id::text || '. No financial operation was replayed for incident closure.'
      WHERE id=v_group.id AND status<>'resolved';
    END IF;
  END LOOP;
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
     AND (i.metadata->>'alert_id')::uuid = NEW.id
     AND (left(i.source,length('financial_alerts:'))<>'financial_alerts:' OR i.source='financial_alerts:' || NEW.source)
     AND NOT(left(i.source,length('financial_alerts:'))='financial_alerts:'
       AND right(i.dedupe_key,32) ~ '^[0-9a-f]{32}$'
       AND i.dedupe_key='fa:' || substr(i.source,length('financial_alerts:')+1) || ':' || right(i.dedupe_key,32));
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
END $function$;
DO $after$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc
  WHERE oid='public.fn_ca_alert_resolution_reaches_the_incident()'::regprocedure
  AND md5(pg_get_functiondef(oid))='c6b3d7c19114d3f42aeaa4a43d8d80ab'
  AND pg_get_userbyid(proowner)='postgres' AND prosecdef
  AND proconfig=ARRAY['search_path=public']::text[]
  AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
  RAISE EXCEPTION 'LEGACY_INCIDENT_BATCH_POSTIMAGE_OR_AUTHORITY_CHANGED';
 END IF;
END $after$;
COMMIT;
