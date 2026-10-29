-- Reserved by scripts/reserve-migration-version.sh.
-- Incident 0377a5ef folded different original hands 51853419 and 51860852,
-- replacing metadata.alert_id while retaining the first typed table_id.
-- Both eventually resolved; the latest alone must never close an unresolved
-- earlier original. Keep future hand-history identity exact, and close legacy
-- aggregates only when their complete interval membership is resolved.
-- No historical rows, financial rules, wallet writes or schedules change.
-- @live-proof: position('NEW.source IN (''postHandTasks.leave_pending_failed'', ''postHandTasks.hand_history_failed'')' IN pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure)) > 0
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure)) = '0ac8ad5a1123baee705afcd80752ec33'
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_alert_resolution_reaches_the_incident()'::regprocedure)) = 'befc00077ec80d4be6260f35fc46d40e'
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
DO $migration$
DECLARE v_src text; v_new text;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_financial_alert_to_incident()'::regprocedure
 AND md5(pg_get_functiondef(oid))='031b932ba81ca2c9960ae3b050cff075' AND pg_get_userbyid(proowner)='postgres'
 AND prosecdef AND proconfig=ARRAY['search_path=public']::text[]
 AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
 RAISE EXCEPTION 'HAND_INCIDENT_PREIMAGE_OR_AUTHORITY_CHANGED: fn_ca_financial_alert_to_incident'; END IF;
 SELECT pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure) INTO v_src;
 v_new:=v_src;
 IF array_length(string_to_array(v_new,$old$NEW.source = 'postHandTasks.leave_pending_failed'$old$),1)<>3 THEN
 RAISE EXCEPTION 'HAND_INCIDENT_ANCHOR_CHANGED: fn_ca_financial_alert_to_incident'; END IF;
 v_new:=replace(v_new,$old$NEW.source = 'postHandTasks.leave_pending_failed'$old$,$new$NEW.source IN ('postHandTasks.leave_pending_failed', 'postHandTasks.hand_history_failed')$new$);
 IF array_length(string_to_array(v_new,$old$THEN 'fa:postHandTasks.leave_pending_failed:'$old$),1)<>2 THEN
 RAISE EXCEPTION 'HAND_INCIDENT_ANCHOR_CHANGED: fn_ca_financial_alert_to_incident'; END IF;
 v_new:=replace(v_new,$old$THEN 'fa:postHandTasks.leave_pending_failed:'$old$,$new$THEN 'fa:' || NEW.source || ':'$new$);
 IF array_length(string_to_array(v_new,$old$A failed leave can strand this table/hand's stack obligation. Keep its$old$),1)<>2 THEN
 RAISE EXCEPTION 'HAND_INCIDENT_ANCHOR_CHANGED: fn_ca_financial_alert_to_incident'; END IF;
 v_new:=replace(v_new,$old$A failed leave can strand this table/hand's stack obligation. Keep its$old$,$new$A failed post-hand obligation belongs to this exact table/hand. Keep its$new$);
 PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_financial_alert_to_incident','migration 20261029180738_hand_history_incidents_retain_exact_original_identity');
 EXECUTE v_new;
 PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_financial_alert_to_incident','migration 20261029180738_hand_history_incidents_retain_exact_original_identity');
END $migration$;
DO $migration$
DECLARE v_src text; v_new text;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_alert_resolution_reaches_the_incident()'::regprocedure
 AND md5(pg_get_functiondef(oid))='792e3db7ccbde4efa527176035fce9af' AND pg_get_userbyid(proowner)='postgres'
 AND prosecdef AND proconfig=ARRAY['search_path=public']::text[]
 AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
 RAISE EXCEPTION 'HAND_INCIDENT_PREIMAGE_OR_AUTHORITY_CHANGED: fn_ca_alert_resolution_reaches_the_incident'; END IF;
 SELECT pg_get_functiondef('public.fn_ca_alert_resolution_reaches_the_incident()'::regprocedure) INTO v_src;
 v_new:=v_src;
 IF array_length(string_to_array(v_new,$old$AND (i.metadata->>'alert_id')::uuid = NEW.id;$old$),1)<>2 THEN
 RAISE EXCEPTION 'HAND_INCIDENT_ANCHOR_CHANGED: fn_ca_alert_resolution_reaches_the_incident'; END IF;
 v_new:=replace(v_new,$old$AND (i.metadata->>'alert_id')::uuid = NEW.id;$old$,$new$AND (
       (i.metadata->>'alert_id')::uuid = NEW.id
       OR (i.source = 'financial_alerts:postHandTasks.hand_history_failed'
          AND i.dedupe_key ~ '^fa:postHandTasks[.]hand_history_failed:[0-9a-f]{32}$'
          AND NEW.source = 'postHandTasks.hand_history_failed'
          AND NEW.created_at BETWEEN i.detected_at AND i.last_seen_at
          AND i.dedupe_key = 'fa:postHandTasks.hand_history_failed:' || md5(
              public.fn_ca_normalize_alert_text(left(NEW.message, 200)) || '|' ||
              public.fn_ca_normalize_alert_text(left(COALESCE(NEW.context->>'error', ''), 200))))
     )
     -- Legacy shape folding replaced metadata while retaining the first typed
     -- table. A last alert is not proof that every folded original resolved.
     AND (NOT (i.source = 'financial_alerts:postHandTasks.hand_history_failed'
          AND i.dedupe_key ~ '^fa:postHandTasks[.]hand_history_failed:[0-9a-f]{32}$') OR (
       (SELECT count(*) FROM public.financial_alerts a
         WHERE a.source = 'postHandTasks.hand_history_failed' AND a.severity = 'critical'
           AND a.created_at BETWEEN i.detected_at AND i.last_seen_at
           AND i.dedupe_key = 'fa:postHandTasks.hand_history_failed:' || md5(
                 public.fn_ca_normalize_alert_text(left(a.message, 200)) || '|' ||
                 public.fn_ca_normalize_alert_text(left(COALESCE(a.context->>'error', ''), 200)))) = i.occurrences
       AND NOT EXISTS (SELECT 1 FROM public.financial_alerts a
         WHERE a.source = 'postHandTasks.hand_history_failed' AND a.severity = 'critical'
           AND a.created_at BETWEEN i.detected_at AND i.last_seen_at
           AND i.dedupe_key = 'fa:postHandTasks.hand_history_failed:' || md5(
                 public.fn_ca_normalize_alert_text(left(a.message, 200)) || '|' ||
                 public.fn_ca_normalize_alert_text(left(COALESCE(a.context->>'error', ''), 200)))
           AND a.resolved IS DISTINCT FROM true)
     ));$new$);

 EXECUTE v_new;

END $migration$;
COMMIT;
