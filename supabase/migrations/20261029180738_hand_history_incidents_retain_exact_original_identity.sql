-- Reserved by scripts/reserve-migration-version.sh.
-- Hand incident 0377a5ef mixed original hands; generic admission group e1e35791
-- closed on its latest alert while three of its six immutable original members
-- remained unresolved. Preserve intentional same-cause aggregation, retain each
-- validated alert UUID in original append-only events, and close the full group
-- only after every exact member resolves. Legacy correlation is event-specific
-- and must be unique; missing/ambiguous members stay unknown. Historical rows
-- and events, financial rules, wallet state and schedules remain unchanged.
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure)) = 'f3b7353cbbb7dd3a03b5dedbecc034b7'
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure)) = '8687f48f6ebd164536a561a5d4e57dfb'
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_alert_resolution_reaches_the_incident()'::regprocedure)) = '6aeff3afb938b152034f9a250efb3e21'
BEGIN;
SET LOCAL lock_timeout='3s';SET LOCAL statement_timeout='15s';
DO $migration$
DECLARE v_src text;v_new text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_financial_alert_to_incident()'::regprocedure
 AND md5(pg_get_functiondef(oid))='031b932ba81ca2c9960ae3b050cff075' AND pg_get_userbyid(proowner)='postgres'
 AND prosecdef AND proconfig=ARRAY['search_path=public']::text[]
 AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
 RAISE EXCEPTION 'INCIDENT_MEMBER_PREIMAGE_OR_AUTHORITY_CHANGED: fn_ca_financial_alert_to_incident';END IF;
 SELECT pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure) INTO v_src;v_new:=v_src;
 IF array_length(string_to_array(v_new,$old$NEW.source = 'postHandTasks.leave_pending_failed'$old$),1)<>3 THEN
 RAISE EXCEPTION 'INCIDENT_MEMBER_ANCHOR_CHANGED: fn_ca_financial_alert_to_incident';END IF;
 v_new:=replace(v_new,$old$NEW.source = 'postHandTasks.leave_pending_failed'$old$,$new$NEW.source IN ('postHandTasks.leave_pending_failed', 'postHandTasks.hand_history_failed')$new$);
 IF array_length(string_to_array(v_new,$old$THEN 'fa:postHandTasks.leave_pending_failed:'$old$),1)<>2 THEN
 RAISE EXCEPTION 'INCIDENT_MEMBER_ANCHOR_CHANGED: fn_ca_financial_alert_to_incident';END IF;
 v_new:=replace(v_new,$old$THEN 'fa:postHandTasks.leave_pending_failed:'$old$,$new$THEN 'fa:' || NEW.source || ':'$new$);
 IF array_length(string_to_array(v_new,$old$A failed leave can strand this table/hand's stack obligation. Keep its$old$),1)<>2 THEN
 RAISE EXCEPTION 'INCIDENT_MEMBER_ANCHOR_CHANGED: fn_ca_financial_alert_to_incident';END IF;
 v_new:=replace(v_new,$old$A failed leave can strand this table/hand's stack obligation. Keep its$old$,$new$A failed post-hand obligation belongs to this exact table/hand. Keep its$new$);
 IF array_length(string_to_array(v_new,$old$     AND i.suspected_cause = left(NEW.message, 300)$old$),1)<>2 THEN
 RAISE EXCEPTION 'INCIDENT_ACTIVE_ECHO_ANCHOR_CHANGED';END IF;
 v_new:=replace(v_new,$old$     AND i.suspected_cause = left(NEW.message, 300)$old$,$new$     AND i.suspected_cause = left(NEW.message, 300)
     AND NOT EXISTS(SELECT 1 FROM public.ca_drift_incidents active_group
       WHERE active_group.dedupe_key=v_dedupe AND active_group.status<>'resolved')$new$);

 PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_financial_alert_to_incident','migration 20261029180738_hand_history_incidents_retain_exact_original_identity');
 EXECUTE v_new;
 PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_financial_alert_to_incident','migration 20261029180738_hand_history_incidents_retain_exact_original_identity');
END $migration$;
DO $migration$
DECLARE v_src text;v_new text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure
 AND md5(pg_get_functiondef(oid))='0d59dc950cdc32ce9df9ac12b02b2c89' AND pg_get_userbyid(proowner)='postgres'
 AND prosecdef AND proconfig=ARRAY['search_path=public']::text[]
 AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
 RAISE EXCEPTION 'INCIDENT_MEMBER_PREIMAGE_OR_AUTHORITY_CHANGED: fn_ca_raise_drift_incident';END IF;
 SELECT pg_get_functiondef('public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure) INTO v_src;v_new:=v_src;
 IF array_length(string_to_array(v_new,$old$  v_stable text;$old$),1)<>2 THEN
 RAISE EXCEPTION 'INCIDENT_MEMBER_ANCHOR_CHANGED: fn_ca_raise_drift_incident';END IF;
 v_new:=replace(v_new,$old$  v_stable text;$old$,$new$  v_stable text;
  v_financial_member jsonb := '{}'::jsonb;$new$);
 IF array_length(string_to_array(v_new,'  UPDATE public.ca_drift_incidents
     SET occurrences'),1)<>2 THEN
 RAISE EXCEPTION 'INCIDENT_MEMBER_ANCHOR_CHANGED: fn_ca_raise_drift_incident';END IF;
 v_new:=replace(v_new,'  UPDATE public.ca_drift_incidents
     SET occurrences','  -- Keep validated original alert identity in the append-only event at the
  -- original raise, including recurrence and concurrent insertion fallback.
  IF left(p_source,length(''financial_alerts:''))=''financial_alerts:'' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(''ca-financial-incident-members:'' || public.fn_ca_stable_dedupe_key(p_dedupe_key),0));
    v_financial_member:=jsonb_build_object(''financial_member_version'',1,''alert_id'',
      CASE WHEN jsonb_typeof(p_metadata->''alert_id'')=''string''
        AND p_metadata->>''alert_id'' ~ ''^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$''
        AND EXISTS(SELECT 1 FROM public.financial_alerts a
          WHERE a.id=CASE WHEN p_metadata->>''alert_id'' ~ ''^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$''
                         THEN (p_metadata->>''alert_id'')::uuid END
            AND a.source=substr(p_source,length(''financial_alerts:'')+1)
            AND a.severity=''critical'')
      THEN lower(p_metadata->>''alert_id'') ELSE NULL END);
  END IF;
  UPDATE public.ca_drift_incidents
     SET occurrences');
 IF array_length(string_to_array(v_new,$old$  IF (SELECT count(*) FROM public.ca_drift_incidents
       WHERE source = p_source AND status <> 'resolved') >= 25 THEN$old$),1)<>2 THEN
 RAISE EXCEPTION 'INCIDENT_STORM_OWNER_ANCHOR_CHANGED';END IF;
 v_new:=replace(v_new,$old$  IF (SELECT count(*) FROM public.ca_drift_incidents
       WHERE source = p_source AND status <> 'resolved') >= 25 THEN$old$,$new$  IF (SELECT count(*) FROM public.ca_drift_incidents
       WHERE source = p_source AND status <> 'resolved') >= 25 THEN
    IF left(p_source,length('financial_alerts:'))='financial_alerts:' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('ca-financial-incident-members:storm:' || p_source,0));
    END IF;$new$);
 IF array_length(string_to_array(v_new,$old$'discrepancy', p_discrepancy));$old$),1)<>2 THEN
 RAISE EXCEPTION 'INCIDENT_MEMBER_ANCHOR_CHANGED: fn_ca_raise_drift_incident';END IF;
 v_new:=replace(v_new,$old$'discrepancy', p_discrepancy));$old$,$new$'discrepancy', p_discrepancy) || v_financial_member);$new$);
 IF array_length(string_to_array(v_new,$old$'note', 'same condition under a new period label; folded rather than re-filed'));$old$),1)<>2 THEN
 RAISE EXCEPTION 'INCIDENT_MEMBER_ANCHOR_CHANGED: fn_ca_raise_drift_incident';END IF;
 v_new:=replace(v_new,$old$'note', 'same condition under a new period label; folded rather than re-filed'));$old$,$new$'note', 'same condition under a new period label; folded rather than re-filed') || v_financial_member);$new$);
 IF array_length(string_to_array(v_new,$old$THEN jsonb_build_object('alert_id',p_metadata->'alert_id') ELSE '{}'::jsonb END);$old$),1)<>2 THEN
 RAISE EXCEPTION 'INCIDENT_MEMBER_ANCHOR_CHANGED: fn_ca_raise_drift_incident';END IF;
 v_new:=replace(v_new,$old$THEN jsonb_build_object('alert_id',p_metadata->'alert_id') ELSE '{}'::jsonb END);$old$,$new$THEN jsonb_build_object('alert_id',p_metadata->'alert_id') ELSE '{}'::jsonb END || v_financial_member);$new$);
 IF array_length(string_to_array(v_new,$old$VALUES (v_id, 'created', jsonb_build_object('source', p_source));$old$),1)<>2 THEN
 RAISE EXCEPTION 'INCIDENT_MEMBER_ANCHOR_CHANGED: fn_ca_raise_drift_incident';END IF;
 v_new:=replace(v_new,$old$VALUES (v_id, 'created', jsonb_build_object('source', p_source));$old$,$new$VALUES (v_id, 'created', jsonb_build_object('source', p_source) || v_financial_member);$new$);
 IF array_length(string_to_array(v_new,$old$     RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.ca_incident_events$old$),1)<>2 THEN
 RAISE EXCEPTION 'INCIDENT_MEMBER_ANCHOR_CHANGED: fn_ca_raise_drift_incident';END IF;
 v_new:=replace(v_new,$old$     RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.ca_incident_events$old$,$new$     RETURNING id INTO v_id;
    IF v_id IS NOT NULL AND v_financial_member <> '{}'::jsonb THEN
      INSERT INTO public.ca_incident_events(incident_id,kind,detail)
      VALUES(v_id,'recurred',jsonb_build_object('source',p_source,'discrepancy',p_discrepancy) || v_financial_member);
    END IF;
    RETURN v_id;
  END IF;

  INSERT INTO public.ca_incident_events$new$);
 PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_raise_drift_incident','migration 20261029180738_hand_history_incidents_retain_exact_original_identity');
 EXECUTE v_new;
 PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_raise_drift_incident','migration 20261029180738_hand_history_incidents_retain_exact_original_identity');
END $migration$;
DO $migration$
DECLARE v_src text;v_new text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_alert_resolution_reaches_the_incident()'::regprocedure
 AND md5(pg_get_functiondef(oid))='792e3db7ccbde4efa527176035fce9af' AND pg_get_userbyid(proowner)='postgres'
 AND prosecdef AND proconfig=ARRAY['search_path=public']::text[]
 AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
 RAISE EXCEPTION 'INCIDENT_MEMBER_PREIMAGE_OR_AUTHORITY_CHANGED: fn_ca_alert_resolution_reaches_the_incident';END IF;
 SELECT pg_get_functiondef('public.fn_ca_alert_resolution_reaches_the_incident()'::regprocedure) INTO v_src;v_new:=v_src;
 IF array_length(string_to_array(v_new,$old$DECLARE v_state text; v_msg text; v_storm record; v_members bigint; v_bad bigint; v_current boolean;$old$),1)<>2 THEN
 RAISE EXCEPTION 'INCIDENT_MEMBER_ANCHOR_CHANGED: fn_ca_alert_resolution_reaches_the_incident';END IF;
 v_new:=replace(v_new,$old$DECLARE v_state text; v_msg text; v_storm record; v_members bigint; v_bad bigint; v_current boolean;$old$,$new$DECLARE v_state text; v_msg text; v_storm record; v_group record; v_members bigint; v_bad bigint; v_current boolean;$new$);
 IF array_length(string_to_array(v_new,$old$  UPDATE public.ca_drift_incidents i$old$),1)<>2 THEN
 RAISE EXCEPTION 'INCIDENT_MEMBER_ANCHOR_CHANGED: fn_ca_alert_resolution_reaches_the_incident';END IF;
 v_new:=replace(v_new,$old$  UPDATE public.ca_drift_incidents i$old$,$new$  -- The original raise and resolution share transaction ownership before any
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
      SELECT e.id,e.detail,m.matches,m.alert_id,m.all_resolved
      FROM public.ca_incident_events e
      CROSS JOIN LATERAL (
        SELECT count(*) AS matches,min(a.id::text) AS alert_id,
               bool_and(a.resolved IS TRUE) AS all_resolved
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
    SELECT count(*),count(*) FILTER(WHERE matches<>1 OR all_resolved IS DISTINCT FROM true
            OR detail->>'source' IS DISTINCT FROM v_group.source),
           COALESCE(bool_or(alert_id=NEW.id::text),false)
      INTO v_members,v_bad,v_current FROM members;
    IF v_members>0 AND v_members=v_group.occurrences AND v_bad=0 AND v_current THEN
      UPDATE public.ca_drift_incidents SET status='resolved',
        resolved_at=GREATEST(now(),detected_at),closure_basis='verified_remeasured',
        correction_ref=COALESCE(NULLIF(correction_ref,''),'verified: every exact cause-group source alert is resolved'),
        root_cause=COALESCE(NULLIF(root_cause,''),
          'This incident is a same-cause financial alert group. Every uniquely identified original source alert is resolved. Typed entity fields retain the first witness; metadata retains the latest witness.'),
        resolution=COALESCE(NULLIF(resolution,'') || ' | ','') ||
          'Verified all ' || v_members || ' exact original source alert members resolved; the final original transition was ' || NEW.id::text || '. No financial operation was replayed for incident closure.'
      WHERE id=v_group.id AND status<>'resolved';
    END IF;
  END LOOP;
  UPDATE public.ca_drift_incidents i$new$);
 IF array_length(string_to_array(v_new,$old$AND (i.metadata->>'alert_id')::uuid = NEW.id;$old$),1)<>2 THEN
 RAISE EXCEPTION 'INCIDENT_MEMBER_ANCHOR_CHANGED: fn_ca_alert_resolution_reaches_the_incident';END IF;
 v_new:=replace(v_new,$old$AND (i.metadata->>'alert_id')::uuid = NEW.id;$old$,$new$AND (i.metadata->>'alert_id')::uuid = NEW.id
     AND (left(i.source,length('financial_alerts:'))<>'financial_alerts:' OR i.source='financial_alerts:' || NEW.source)
     AND NOT(left(i.source,length('financial_alerts:'))='financial_alerts:'
       AND right(i.dedupe_key,32) ~ '^[0-9a-f]{32}$'
       AND i.dedupe_key='fa:' || substr(i.source,length('financial_alerts:')+1) || ':' || right(i.dedupe_key,32));$new$);

 EXECUTE v_new;

END $migration$;
COMMIT;
