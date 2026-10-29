-- Grouped daily critical signals must carry exact original inbox identities.
-- Counts, thresholds, original events and financial state are preserved.
-- @live-proof: (SELECT md5(prosrc) = 'aa0d0c539e7e03de275c018d1b3c7313' FROM pg_proc WHERE oid = 'public.fn_sp_digest_attention(date,jsonb)'::regprocedure) AND (SELECT md5(prosrc) = '884fffb024e00922acf9eb73d9cece75' FROM pg_proc WHERE oid = 'public.fn_sp_daily_digest(date,boolean)'::regprocedure)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
DO $pre$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_sp_daily_digest(date,boolean)'::regprocedure) IS DISTINCT FROM 'e9d473fb8029658a9ae687ccfd584f33' THEN RAISE EXCEPTION 'DIGEST_GROUP_PREIMAGE_DRIFT fn_sp_daily_digest(date,boolean)'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_sp_digest_attention(date,jsonb)'::regprocedure) IS DISTINCT FROM 'd2b05df21f8087a77e5d979e2ca45dea' THEN RAISE EXCEPTION 'DIGEST_GROUP_PREIMAGE_DRIFT fn_sp_digest_attention(date,jsonb)'; END IF;
END $pre$;
DO $fix$
DECLARE b text; old text; replacement text;
BEGIN
 SELECT pg_get_functiondef('public.fn_sp_digest_attention(date,jsonb)'::regprocedure) INTO b;
 old := $old$  prev jsonb;$old$;
 replacement := $new$  v_source_events jsonb;
  prev jsonb;$new$;
 IF (length(b)-length(replace(b,old,'')))/length(old) <> 1 THEN
  RAISE EXCEPTION 'DIGEST_GROUP_PREIMAGE_DRIFT fn_sp_digest_attention(date,jsonb)';
 END IF;
 EXECUTE replace(b,old,replacement);
 SELECT pg_get_functiondef('public.fn_sp_digest_attention(date,jsonb)'::regprocedure) INTO b;
 old := $old$  WITH history AS MATERIALIZED (
    SELECT alertname,
           count(*) FILTER (WHERE received_at >= s - interval '1 day'
                            AND investigation_status IS DISTINCT FROM 'informational') AS prior
      FROM public.operational_alert_events
     WHERE received_at >= s - interval '7 days' AND received_at < s
       AND severity = 'critical'
       AND payload->>'snapshot_kind' IS DISTINCT FROM 'update_new'
     GROUP BY alertname
$old$;
 replacement := $new$  WITH original_inbox AS MATERIALIZED (
    SELECT id,alertname,received_at,investigation_status
      FROM public.operational_alert_events
     WHERE received_at >= s - interval '7 days' AND received_at < e
       AND severity='critical'
       AND payload->>'snapshot_kind' IS DISTINCT FROM 'update_new'
  ), history AS MATERIALIZED (
    SELECT alertname,
           count(*) FILTER (WHERE received_at >= s - interval '1 day'
                            AND investigation_status IS DISTINCT FROM 'informational') AS prior
      FROM original_inbox
     WHERE received_at < s
     GROUP BY alertname
$new$;
 IF (length(b)-length(replace(b,old,'')))/length(old) <> 1 THEN RAISE EXCEPTION 'DIGEST_GROUP_PREIMAGE_DRIFT history'; END IF;
 EXECUTE replace(b,old,replacement);
 SELECT pg_get_functiondef('public.fn_sp_digest_attention(date,jsonb)'::regprocedure) INTO b;
 old := $old$      FROM history GROUP BY COALESCE(alertname,'unknown')
  )$old$;
 replacement := $new$      FROM history GROUP BY COALESCE(alertname,'unknown')
  ), source_day AS MATERIALIZED (
    SELECT COALESCE(alertname,'unknown') alertname, jsonb_agg(id ORDER BY id) event_ids
      FROM original_inbox
     WHERE received_at >= s
       AND investigation_status IS DISTINCT FROM 'informational'
     GROUP BY COALESCE(alertname,'unknown')
  )$new$;
 IF (length(b)-length(replace(b,old,'')))/length(old) <> 1 THEN
  RAISE EXCEPTION 'DIGEST_GROUP_PREIMAGE_DRIFT fn_sp_digest_attention(date,jsonb)';
 END IF;
 EXECUTE replace(b,old,replacement);
 SELECT pg_get_functiondef('public.fn_sp_digest_attention(date,jsonb)'::regprocedure) INTO b;
 old := $old$SELECT count(*), string_agg(format('%s (%s, %s the day before)', z.alertname, z.n, z.prior), '; ' ORDER BY z.n DESC)
    INTO v, t$old$;
 replacement := $new$SELECT count(*), string_agg(format('%s (%s, %s the day before)', z.alertname, z.n, z.prior), '; ' ORDER BY z.n DESC),
         jsonb_agg(jsonb_build_object('alertname',z.alertname,'expected_count',z.n,
           'event_ids',COALESCE(original.event_ids,'[]'::jsonb)) ORDER BY z.alertname)
    INTO v, t, v_source_events$new$;
 IF (length(b)-length(replace(b,old,'')))/length(old) <> 1 THEN
  RAISE EXCEPTION 'DIGEST_GROUP_PREIMAGE_DRIFT fn_sp_digest_attention(date,jsonb)';
 END IF;
 EXECUTE replace(b,old,replacement);
 SELECT pg_get_functiondef('public.fn_sp_digest_attention(date,jsonb)'::regprocedure) INTO b;
 old := $old$    ) z;
  IF v > 0 THEN
    a := a || jsonb_build_object('rule','critical_alert_rising'$old$;
 replacement := $new$    ) z LEFT JOIN source_day original ON original.alertname = z.alertname;
  IF v > 0 THEN
    a := a || jsonb_build_object('rule','critical_alert_rising'$new$;
 IF (length(b)-length(replace(b,old,'')))/length(old) <> 1 THEN
  RAISE EXCEPTION 'DIGEST_GROUP_PREIMAGE_DRIFT fn_sp_digest_attention(date,jsonb)';
 END IF;
 EXECUTE replace(b,old,replacement);
 SELECT pg_get_functiondef('public.fn_sp_digest_attention(date,jsonb)'::regprocedure) INTO b;
 old := $old$'detail', jsonb_build_object('count', v, 'alerts', t));$old$;
 replacement := $new$'detail', jsonb_build_object('count', v, 'alerts', t, 'source_events',v_source_events));$new$;
 IF (length(b)-length(replace(b,old,'')))/length(old) <> 1 THEN
  RAISE EXCEPTION 'DIGEST_GROUP_PREIMAGE_DRIFT fn_sp_digest_attention(date,jsonb)';
 END IF;
 EXECUTE replace(b,old,replacement);
 SELECT pg_get_functiondef('public.fn_sp_daily_digest(date,boolean)'::regprocedure) INTO b;
 old := $old$                       WHEN NOT (it ? 'alert_event_id') THEN 'tracked'$old$;
 replacement := $new$                       WHEN it->>'rule' = 'critical_alert_rising' THEN
                         CASE WHEN NOT grouped.linkage_complete THEN 'tracked'
                              WHEN grouped.reviewed = grouped.members THEN 'fixed'
                              WHEN grouped.investigating > 0 THEN 'in_progress'
                              ELSE 'not_picked_up' END
                       WHEN NOT (it ? 'alert_event_id') THEN 'tracked'$new$;
 IF (length(b)-length(replace(b,old,'')))/length(old) <> 1 THEN
  RAISE EXCEPTION 'DIGEST_GROUP_PREIMAGE_DRIFT fn_sp_daily_digest(date,boolean)';
 END IF;
 EXECUTE replace(b,old,replacement);
 SELECT pg_get_functiondef('public.fn_sp_daily_digest(date,boolean)'::regprocedure) INTO b;
 old := $old$                       ELSE o.investigation->>'resolution' END) x$old$;
 replacement := $new$                       WHEN it->>'rule' = 'critical_alert_rising' THEN
                         CASE WHEN NOT grouped.linkage_complete
                              THEN 'Original alert linkage is incomplete; historical counts are retained. No assignment or resolution is inferred.'
                              ELSE format('%s of %s linked original alert records are resolved or reviewed; historical daily counts are retained.',grouped.reviewed,grouped.members) END
                       ELSE o.investigation->>'resolution' END) x$new$;
 IF (length(b)-length(replace(b,old,'')))/length(old) <> 1 THEN
  RAISE EXCEPTION 'DIGEST_GROUP_PREIMAGE_DRIFT fn_sp_daily_digest(date,boolean)';
 END IF;
 EXECUTE replace(b,old,replacement);
 SELECT pg_get_functiondef('public.fn_sp_daily_digest(date,boolean)'::regprocedure) INTO b;
 old := $old$      LEFT JOIN public.operational_alert_events o ON o.id = (it->>'alert_event_id')::bigint) z;$old$;
 replacement := $new$      LEFT JOIN public.operational_alert_events o ON o.id = (it->>'alert_event_id')::bigint
      LEFT JOIN LATERAL (
        WITH groups AS (
          SELECT q.x FROM jsonb_array_elements(CASE
            WHEN jsonb_typeof(it#>'{detail,source_events}')='array'
            THEN it#>'{detail,source_events}' ELSE '[]'::jsonb END) q(x)
        ), members AS (
          SELECT g.x->>'alertname' alertname,
                 CASE WHEN jsonb_typeof(i.x)='number' AND i.x::text ~ '^[1-9][0-9]{0,18}$'
                      THEN CASE WHEN (i.x::text)::numeric <= 9223372036854775807
                                THEN (i.x::text)::bigint END END id
            FROM groups g CROSS JOIN LATERAL jsonb_array_elements(CASE
              WHEN jsonb_typeof(g.x->'event_ids')='array' THEN g.x->'event_ids' ELSE '[]'::jsonb END) i(x)
        )
        SELECT count(*) members,
               count(*) FILTER(WHERE original.investigation_status IN ('verified_fixed','historical')
                 OR EXISTS(SELECT 1 FROM public.financial_alerts financial
                   WHERE original.source IN ('financial-alerts-backfill','financial-alerts-updates')
                     AND financial.id=CASE WHEN pg_input_is_valid(original.payload#>>'{original_event,id}','uuid')
                                           THEN (original.payload#>>'{original_event,id}')::uuid END
                     AND financial.source=original.alertname
                     AND CASE WHEN pg_input_is_valid(original.payload#>>'{original_event,created_at}','timestamp with time zone')
                              THEN financial.created_at=(original.payload#>>'{original_event,created_at}')::timestamptz ELSE false END
                     AND financial.resolved IS TRUE AND financial.resolved_at>=financial.created_at)
                 OR EXISTS(SELECT 1 FROM public.operational_alert_events closed
                   WHERE original.source='alertmanager' AND closed.source='alertmanager' AND closed.status='resolved'
                     AND closed.alertname=original.alertname
                     AND nullif(original.payload#>>'{alert,fingerprint}','') IS NOT NULL
                     AND closed.payload#>>'{alert,fingerprint}'=original.payload#>>'{alert,fingerprint}'
                     AND nullif(original.payload#>>'{alert,startsAt}','') IS NOT NULL
                     AND closed.payload#>>'{alert,startsAt}'=original.payload#>>'{alert,startsAt}'
                     AND jsonb_typeof(original.payload#>'{alert,labels}')='object'
                     AND original.payload#>>'{alert,labels,alertname}'=original.alertname
                     AND closed.payload#>'{alert,labels}'=original.payload#>'{alert,labels}'
                     AND closed.payload#>>'{alert,status}'='resolved'
                     AND COALESCE(closed.last_received_at,closed.received_at)>=COALESCE(original.last_received_at,original.received_at)
                     AND CASE WHEN pg_input_is_valid(original.payload#>>'{alert,startsAt}','timestamp with time zone')
                                   AND pg_input_is_valid(closed.payload#>>'{alert,endsAt}','timestamp with time zone')
                              THEN (closed.payload#>>'{alert,endsAt}')::timestamptz >= (original.payload#>>'{alert,startsAt}')::timestamptz
                              ELSE false END)) reviewed,
               count(*) FILTER(WHERE original.investigation_status='investigating') investigating,
               count(*)>0 AND count(*)=count(DISTINCT m.id) AND
               COALESCE(bool_and(COALESCE(original.id IS NOT NULL
                 AND COALESCE(original.alertname,'unknown')=m.alertname
                 AND original.severity='critical'
                 AND original.received_at >= (v_day::timestamp AT TIME ZONE 'America/Chicago')
                 AND original.received_at < ((v_day+1)::timestamp AT TIME ZONE 'America/Chicago')
                 AND original.payload->>'snapshot_kind' IS DISTINCT FROM 'update_new',false)),false)
               AND (SELECT count(*)>0 AND count(*)=count(DISTINCT x->>'alertname')
                 AND to_jsonb(count(*))=it#>'{detail,count}'
                 AND COALESCE(bool_and(COALESCE(jsonb_typeof(x->'alertname')='string'
                   AND x->>'alertname'<>'' AND jsonb_typeof(x->'event_ids')='array'
                   AND jsonb_array_length(CASE WHEN jsonb_typeof(x->'event_ids')='array' THEN x->'event_ids' ELSE '[]'::jsonb END)>0
                   AND x->'expected_count'=v_row.metrics#>ARRAY['health','alert_names',x->>'alertname']
                   AND x->'expected_count'=to_jsonb(jsonb_array_length(CASE WHEN jsonb_typeof(x->'event_ids')='array' THEN x->'event_ids' ELSE '[]'::jsonb END)),false)),false)
                   FROM groups) linkage_complete
          FROM members m LEFT JOIN public.operational_alert_events original ON original.id=m.id
      ) grouped ON it->>'rule'='critical_alert_rising') z;$new$;
 IF (length(b)-length(replace(b,old,'')))/length(old) <> 1 THEN
  RAISE EXCEPTION 'DIGEST_GROUP_PREIMAGE_DRIFT fn_sp_daily_digest(date,boolean)';
 END IF;
 EXECUTE replace(b,old,replacement);
END $fix$;
-- Only this witnessed historical group can be linked retroactively. Other
-- unlinked historical counts remain explicitly unknown, never guessed by type.
DO $history$
DECLARE original jsonb; linked jsonb := '[{"alertname":"OpenClawFleetLongSilence","expected_count":1,"event_ids":[289742]},{"alertname":"Tournament.atomic_satellite_finish_refused","expected_count":1,"event_ids":[291196]}]'::jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM public.sp_daily_metrics WHERE day='2026-10-28') THEN
   SELECT x INTO original FROM public.sp_daily_metrics m,
     LATERAL jsonb_array_elements(m.attention) q(x)
    WHERE m.day='2026-10-28' AND x->>'rule'='critical_alert_rising'
      AND m.computed_at='2026-10-29T05:21:21.075476Z'::timestamptz
      AND m.metrics#>'{health,alert_names,OpenClawFleetLongSilence}'='1'::jsonb
      AND m.metrics#>'{health,alert_names,Tournament.atomic_satellite_finish_refused}'='1'::jsonb;
   IF original IS NULL OR (SELECT count(*) FROM public.sp_daily_metrics m,LATERAL jsonb_array_elements(m.attention) q(x) WHERE m.day='2026-10-28' AND x->>'rule'='critical_alert_rising')<>1 OR original#>'{detail,count}' IS DISTINCT FROM '2'::jsonb
     OR original#>>'{detail,alerts}' IS DISTINCT FROM 'OpenClawFleetLongSilence (1, 0 the day before); Tournament.atomic_satellite_finish_refused (1, 0 the day before)'
     OR original#>'{detail,source_events}' IS NOT NULL
     OR NOT EXISTS(SELECT 1 FROM public.operational_alert_events WHERE id=289742 AND alertname='OpenClawFleetLongSilence' AND severity='critical'
       AND received_at='2026-10-28T17:01:11.415596Z'::timestamptz
       AND payload#>>'{alert,startsAt}'='2026-10-28T17:01:00.848Z')
     OR NOT EXISTS(SELECT 1 FROM public.operational_alert_events WHERE id=291196 AND alertname='Tournament.atomic_satellite_finish_refused' AND severity='critical'
       AND received_at='2026-10-28T23:42:42.454884Z'::timestamptz
       AND payload#>>'{original_event,id}'='10063685-5d51-4fd9-9d46-b4a8fcd28744') THEN
     RAISE EXCEPTION 'DIGEST_GROUP_HISTORICAL_PREIMAGE_DRIFT';
   END IF;
   UPDATE public.sp_daily_metrics m SET attention=(SELECT jsonb_agg(
     CASE WHEN x=original THEN jsonb_set(x,'{detail,source_events}',linked,true) ELSE x END ORDER BY ordinal)
      FROM jsonb_array_elements(m.attention) WITH ORDINALITY q(x,ordinal))
    WHERE m.day='2026-10-28';
 END IF;
END $history$;
COMMIT;
