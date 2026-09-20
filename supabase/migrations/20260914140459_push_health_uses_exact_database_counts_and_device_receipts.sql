BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_caller_is_engine()'::regprocedure)) <> 'd9a70f1d932538025e656bfe2b4d091d'
  OR to_regprocedure('public.fn_push_health_snapshot(uuid)') IS NOT NULL
 THEN RAISE EXCEPTION 'push health reader dependency changed since review'; END IF;
END $guard$;

CREATE FUNCTION public.fn_push_health_snapshot(p_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public SET statement_timeout='10s' AS $function$
DECLARE stamp timestamptz:=statement_timestamp(); result jsonb;
BEGIN
 IF p_user_id IS NULL OR (auth.uid() IS DISTINCT FROM p_user_id AND NOT public.fn_caller_is_engine())
  OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_user_id AND role IN('admin','god'))
 THEN RAISE EXCEPTION 'admin_required' USING ERRCODE='42501'; END IF;
 -- Counts are computed in PostgreSQL, not from a PostgREST-limited sample.
 -- This fixed seven-day window cannot be widened by a caller. Backlog counts
 -- deliberately include older unfinished rows so stranded work stays visible.
 WITH recent AS MATERIALIZED (
  SELECT event,status,failure_reason,created_at,sent_at FROM public.push_outbox
   WHERE created_at>=stamp-interval '7 days' AND created_at<=stamp
 ), subs AS MATERIALIZED (
  SELECT id,user_id,is_active,last_used_at,last_receipt_at,last_failure_reason,created_at
   FROM public.push_subscriptions
 ), dispatch AS MATERIALIZED (
  SELECT started_at,finished_at,claimed,sent,failed,skipped,note
   FROM public.push_dispatch_runs WHERE job='push-dispatch' ORDER BY started_at DESC LIMIT 10
 ), volume AS (
  SELECT COALESCE(event,'unknown') event,count(*) total,count(*) FILTER(WHERE status='sent') sent
   FROM recent GROUP BY COALESCE(event,'unknown')
 ), reasons AS (
  SELECT split_part(COALESCE(NULLIF(failure_reason,''),'unknown'),':',1) reason,count(*) count
   FROM recent WHERE status IN('failed','skipped') GROUP BY 1
 ), staff AS (
  SELECT p.id,p.username,p.email,p.role,
   CASE WHEN count(s.id)=0 THEN 'never_enabled'
    WHEN count(s.id) FILTER(WHERE s.is_active)=0 THEN 'subscription_dead'
    WHEN count(s.id) FILTER(WHERE s.is_active AND s.last_receipt_at>=stamp-interval '3 days' AND s.last_receipt_at<=stamp)=0 THEN 'zombie'
    ELSE 'ok' END status,
   count(s.id) FILTER(WHERE s.is_active) devices,count(s.id) "totalDevices",
   max(s.last_receipt_at) FILTER(WHERE s.is_active AND s.last_receipt_at<=stamp) "lastReceiptAt",
   (array_agg(s.last_failure_reason ORDER BY s.last_used_at DESC NULLS LAST,s.id) FILTER(WHERE s.is_active AND s.last_failure_reason IS NOT NULL))[1] "lastFailure"
   FROM public.profiles p LEFT JOIN subs s ON s.user_id=p.id WHERE p.role IN('admin','god')
   GROUP BY p.id,p.username,p.email,p.role
 ), queue AS (
  SELECT count(*) FILTER(WHERE status='pending') pending,count(*) FILTER(WHERE status='processing') processing,
   count(*) FILTER(WHERE status='failed') failed,count(*) FILTER(WHERE status='skipped') skipped,
   count(*) FILTER(WHERE status='sent' AND sent_at>=stamp-interval '24 hours' AND sent_at<=stamp) sent24
   FROM public.push_outbox
 ), funnel AS (
  SELECT count(*) FILTER(WHERE created_at>=stamp-interval '24 hours') queued,
   count(*) FILTER(WHERE created_at>=stamp-interval '24 hours' AND status IN('skipped','failed')) suppressed,
   count(*) FILTER(WHERE created_at>=stamp-interval '24 hours' AND status='sent' AND sent_at<=stamp) sent
   FROM recent
 ), devices AS (
  SELECT count(*) total,count(*) FILTER(WHERE is_active) active,
   count(*) FILTER(WHERE is_active AND created_at<stamp-interval '3 days' AND last_used_at>=stamp-interval '3 days' AND last_used_at<=stamp
    AND (last_receipt_at IS NULL OR last_receipt_at<stamp-interval '3 days' OR last_receipt_at>stamp)) zombies,
   count(*) FILTER(WHERE is_active AND last_used_at>=stamp-interval '24 hours' AND last_used_at<=stamp) pushed,
   count(*) FILTER(WHERE is_active AND last_used_at>=stamp-interval '24 hours' AND last_used_at<=stamp
    AND last_receipt_at>=stamp-interval '24 hours' AND last_receipt_at<=stamp) confirmed FROM subs
 )
 SELECT jsonb_build_object(
  'schemaVersion',1,'observedAt',stamp,'windowDays',7,
  'dispatch',jsonb_build_object('lastRunAt',(SELECT max(started_at) FROM dispatch),
   'minutesSince',(SELECT CASE WHEN max(started_at) IS NOT NULL THEN greatest(0,round(extract(epoch FROM(stamp-max(started_at)))/60)) END FROM dispatch),
   'recent',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.started_at DESC) FROM dispatch d),'[]'::jsonb)),
  'subscriptions',jsonb_build_object('total',d.total,'active',d.active,'zombies',d.zombies),
  'outbox',jsonb_build_object('pending',q.pending,'processing',q.processing,'failed',q.failed,'skipped',q.skipped,'sentLast24h',q.sent24),
  'funnel',jsonb_build_object('windowHours',24,'queued',f.queued,'sent',f.sent,'suppressed',f.suppressed,
   'devicesPushed',d.pushed,'devicesConfirmed',d.confirmed,
   'confirmRate',CASE WHEN d.pushed>0 THEN round(100.0*d.confirmed/d.pushed) ELSE NULL END,
   'deliveryRate',CASE WHEN f.queued>0 THEN round(100.0*f.sent/f.queued) ELSE NULL END),
  'skipReasons',COALESCE((SELECT jsonb_agg(jsonb_build_object('reason',r.reason,'count',r.count,'kind',
   CASE WHEN r.reason IN('mute_all','push_disabled','type_disabled','legacy_disabled','quiet_hours','daily_cap_reached') THEN 'user_choice'
    WHEN r.reason='no_subscription' THEN 'not_enrolled'
    WHEN r.reason IN('too_stale_to_deliver','time_budget_exhausted','digested_into') THEN 'throttled' ELSE 'fault' END)
    ORDER BY r.count DESC,r.reason) FROM reasons r),'[]'::jsonb),
  'byType',COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.total DESC,v.event) FROM volume v),'[]'::jsonb),
  'staff',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY (s.status='ok'),s.username,s.id) FROM staff s),'[]'::jsonb)
 ) INTO result FROM queue q CROSS JOIN funnel f CROSS JOIN devices d;
 RETURN result;
END $function$;
REVOKE ALL ON FUNCTION public.fn_push_health_snapshot(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_push_health_snapshot(uuid) TO authenticated,service_role;
COMMENT ON FUNCTION public.fn_push_health_snapshot(uuid) IS 'Read-only admin push health. Exact database aggregates, fixed seven-day grouping window, all-age backlog, receipt-based confirmation, one statement snapshot. No sends or writes.';
COMMIT;
