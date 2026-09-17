-- Existing isolated PG17 source-intake allocation only. All mutations roll back.
-- This reproduces the original-import reader failure, then tests the guarded
-- repair through both the reader and an actual drift UPDATE capture.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='3s';
SET LOCAL timezone='UTC';
SET LOCAL search_path=public,pg_temp;
CREATE TEMP TABLE legacy_execution AS SELECT :'execution_uuid'::uuid execution;
CREATE FUNCTION pg_temp.legacy_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'legacy envelope qualification: %',label; END IF; END $$;
SELECT pg_temp.legacy_assert(current_user='postgres' AND session_user='postgres'
 AND current_database()='qual_owner_notify_'||replace(execution::text,'-','')
 AND inet_server_addr() IS NULL AND current_setting('server_version_num')::integer BETWEEN 170000 AND 179999,
 'exact existing disposable PG17 allocation') FROM legacy_execution;
\ir ../../supabase/components/direct-operational-source-intake.postimage.sql
CREATE TEMP TABLE legacy_function_before AS SELECT to_jsonb(p) value FROM pg_proc p
 WHERE oid='operational_source_intake.receipt_row(public.operational_alert_events,text)'::regprocedure;
CREATE TEMP TABLE legacy_cases(kind text PRIMARY KEY,original jsonb,event public.operational_alert_events);
INSERT INTO legacy_cases
SELECT k,original,jsonb_populate_record(NULL::public.operational_alert_events,
 jsonb_build_object('source',prefix||'-backfill','event_key',original->>'id',
 'alertname','LegacyOriginalImport','status','firing','severity','warning',
 'payload',jsonb_build_object(field,original,'backfill_requested_at','2026-09-13T16:30:00Z',
 'backfill_window_start','2026-09-06T16:30:00Z')))
FROM (VALUES
 ('engine','engine-alerts','original_event',jsonb_build_object('id',900001,'alertname','LegacyOriginalImport','status','firing','severity','warning')),
 ('financial','financial-alerts','original_event',jsonb_build_object('id','ed110000-0000-4000-8000-000000000001','source','LegacyOriginalImport','resolved',false,'severity','warning')),
 ('drift','drift-incidents','original_incident',jsonb_build_object('id','ed110000-0000-4000-8000-000000000002','source','LegacyOriginalImport','status','open','severity','warning'))
) v(k,prefix,field,original);
DO $baseline$
DECLARE r record; got text;
BEGIN
 FOR r IN SELECT * FROM legacy_cases LOOP
  got:=NULL;
  BEGIN PERFORM operational_source_intake.receipt_row(r.event,r.kind);
  EXCEPTION WHEN OTHERS THEN got:=SQLERRM; END;
  PERFORM pg_temp.legacy_assert(got='operational source task is missing outside retained legacy envelope',
   'old implementation must reproduce original-import refusal for '||r.kind);
 END LOOP;
END $baseline$;
\ir ../../supabase/components/direct-operational-source-legacy-envelope.sql
\ir ../../supabase/components/direct-operational-source-legacy-envelope.sql
DO $candidate$
DECLARE r record; e public.operational_alert_events; got text; c integer;
BEGIN
 FOR r IN SELECT * FROM legacy_cases LOOP
  PERFORM pg_temp.legacy_assert(operational_source_intake.receipt_row(r.event,r.kind)=r.original,
   'exact original-import row returned for '||r.kind);
  FOR c IN 1..9 LOOP
   e:=r.event;
   CASE c
    WHEN 1 THEN e.payload:=e.payload-'backfill_requested_at';
    WHEN 2 THEN e.payload:=jsonb_set(e.payload,'{backfill_requested_at}','null');
    WHEN 3 THEN e.payload:=jsonb_set(e.payload,'{backfill_window_start}','false');
    WHEN 4 THEN e.payload:=e.payload||'{"snapshot_kind":"insert"}'::jsonb;
    WHEN 5 THEN e.payload:=e.payload||'{"evidence_reference":{}}'::jsonb;
    WHEN 6 THEN e.payload:=e.payload||'{"target_task_id":"00000000-0000-4000-8000-000000000000"}'::jsonb;
    WHEN 7 THEN e.source:=replace(e.source,'-backfill','-updates');
    WHEN 8 THEN e.event_key:=e.event_key||':wrong';
    WHEN 9 THEN e.severity:='critical';
   END CASE;
   got:=NULL;
   BEGIN PERFORM operational_source_intake.receipt_row(e,r.kind);
   EXCEPTION WHEN OTHERS THEN got:=SQLERRM; END;
   PERFORM pg_temp.legacy_assert(got IS NOT NULL,'malformed or mismatched legacy envelope refused case '||c||' for '||r.kind);
  END LOOP;
 END LOOP;
END $candidate$;

-- Actual existing financial producer/mirror establishes the source row. The
-- test alone models its old imported inbox envelope; the repair never rewrites it.
INSERT INTO financial_alerts(severity,source,message,context)
 VALUES('critical','postHandTasks.leave_pending_failed','Isolated legacy import capture regression',
 jsonb_build_object('table_id','10000000-0000-4000-8000-000000000001','hand_number',18,
 'error','supabase_timeout','club_id','fade0000-0000-0000-0000-000000000001','amount',12))
 RETURNING id AS legacy_financial_id \gset
SELECT pg_temp.legacy_assert((SELECT count(*)=1 FROM ca_drift_incidents
 WHERE metadata->>'alert_id'=:'legacy_financial_id'),'real financial mirror created one drift source');
UPDATE operational_alert_events e SET payload=jsonb_build_object(
 'original_incident',e.payload->'original_incident','backfill_requested_at','2026-09-13T16:30:00Z',
 'backfill_window_start','2026-09-06T16:30:00Z')
 WHERE e.source='drift-incidents-backfill' AND e.event_key=(SELECT id::text FROM ca_drift_incidents
 WHERE metadata->>'alert_id'=:'legacy_financial_id');
CREATE TEMP TABLE legacy_original_inbox AS SELECT to_jsonb(e) value FROM operational_alert_events e
 WHERE e.source='drift-incidents-backfill' AND e.event_key=(SELECT id::text FROM ca_drift_incidents
 WHERE metadata->>'alert_id'=:'legacy_financial_id');
UPDATE ca_drift_incidents SET occurrences=occurrences+1 WHERE metadata->>'alert_id'=:'legacy_financial_id';
SELECT pg_temp.legacy_assert((SELECT count(*)=1 AND bool_and((
 public.fn_read_operational_source_snapshot(e.id)=to_jsonb(i)
 AND e.payload->>'target_task_id'='01a09b86-5ba8-7290-8657-1041f13dd3ca'
 AND e.payload->>'original_inbox_id'=(SELECT value->>'id' FROM legacy_original_inbox)) IS TRUE)
 FROM ca_drift_incidents i JOIN operational_alert_events e ON e.source='drift-incidents-updates'
 AND e.event_key=i.id::text||':'||md5(to_jsonb(i)::text)
 WHERE i.metadata->>'alert_id'=:'legacy_financial_id'),
 'actual updated source reaches exact task-bound inbox with full hydration and original linkage');
SELECT pg_temp.legacy_assert(NOT EXISTS(SELECT 1 FROM operational_source_intake.snapshots s
 JOIN operational_source_intake.deliveries d USING(snapshot_id) WHERE s.source_kind='drift'
 AND s.source_id=(SELECT id::text FROM ca_drift_incidents WHERE metadata->>'alert_id'=:'legacy_financial_id')
 AND d.state<>'captured'),'both preserved source snapshots have captured receipts');
SELECT pg_temp.legacy_assert((SELECT to_jsonb(e)=o.value FROM operational_alert_events e
 JOIN legacy_original_inbox o ON e.id=(o.value->>'id')::bigint), 'original imported envelope never rewritten');
\ir ../../supabase/components/direct-operational-source-legacy-envelope.rollback.sql
\ir ../../supabase/components/direct-operational-source-legacy-envelope.rollback.sql
SELECT pg_temp.legacy_assert((SELECT to_jsonb(p)=b.value FROM pg_proc p CROSS JOIN legacy_function_before b
 WHERE p.oid='operational_source_intake.receipt_row(public.operational_alert_events,text)'::regprocedure),
 'full function identity and authority restored by exact rollback');
\ir ../../supabase/components/direct-operational-source-intake.postimage.sql
ROLLBACK;
SELECT 'legacy original import: old refusal reproduced; three kinds,27 negatives and real drift update passed' AS qualification;
