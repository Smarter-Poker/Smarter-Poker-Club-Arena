-- SOURCE ONLY / UNRUN. This removes only active capture and restores the exact
-- recorder preimage. Immutable originals, pending deliveries, read hydration,
-- and inbox receipts survive. No evidence or financial rows are deleted.
-- Requires the same external DDL serialization as forward installation.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path=public,pg_catalog;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
LOCK TABLE public.ca_drift_incidents,public.engine_alert_delivery_receipts,
 public.engine_alerts,public.financial_alerts,public.operational_alert_events IN SHARE ROW EXCLUSIVE MODE;
\ir direct-operational-source-intake.authority.sql
SELECT pg_temp.assert_direct_source_authority('3b97b07170b81947137ee2adfc268717',true);
\ir direct-operational-source-intake.postimage.sql
DO $binding$
BEGIN
 IF current_user<>'postgres' OR
   (SELECT count(*) FROM pg_trigger WHERE tgname='a00_operational_source_intake'
     AND tgrelid IN ('public.engine_alerts'::regclass,'public.financial_alerts'::regclass,'public.ca_drift_incidents'::regclass)
     AND tgenabled='O' AND tgtype=21 AND NOT tgdeferrable AND NOT tginitdeferred AND tgqual IS NULL
     AND tgfoid='public.fn_capture_operational_source_event()'::regprocedure)<>3
 THEN RAISE EXCEPTION 'direct operational source: rollback trigger authority differs'; END IF;
END $binding$;
DROP TRIGGER a00_operational_source_intake ON public.engine_alerts;
DROP TRIGGER a00_operational_source_intake ON public.financial_alerts;
DROP TRIGGER a00_operational_source_intake ON public.ca_drift_incidents;
DROP FUNCTION public.fn_capture_operational_source_event();
DROP FUNCTION public.fn_retry_operational_source_snapshot(uuid);
CREATE OR REPLACE FUNCTION public.fn_record_engine_alerts(p_alerts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_alert jsonb;
  v_event_id uuid;
  v_existing public.engine_alert_delivery_receipts%rowtype;
  v_id bigint;
  v_lock_key bigint;
  v_receipts jsonb := '[]'::jsonb;
begin
  if p_alerts is null or jsonb_typeof(p_alerts) <> 'array'
     or jsonb_array_length(p_alerts) > 200 or pg_column_size(p_alerts) > 262144 then
    raise exception using errcode = '22023', message = 'Malformed engine alert batch';
  end if;
  -- Validate every member before any insert. The whole function is atomic,
  -- including later cast errors or a producer-ID collision within this batch.
  for v_alert in select value from jsonb_array_elements(p_alerts) loop
    if jsonb_typeof(v_alert) <> 'object'
       or jsonb_typeof(v_alert->'labels') is distinct from 'object'
       or jsonb_typeof(v_alert->'labels'->'alertname') is distinct from 'string'
       or btrim(v_alert->'labels'->>'alertname') = ''
       or (v_alert->>'status') is null or (v_alert->>'status') not in ('firing', 'resolved') then
      raise exception using errcode = '22023', message = 'Malformed engine alert';
    end if;
    if (v_alert->'labels') ? 'engine_alert_event_id' and
       (jsonb_typeof(v_alert->'labels'->'engine_alert_event_id') is distinct from 'string'
        or (v_alert->'labels'->>'engine_alert_event_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception using errcode = '22023', message = 'Malformed engine event ID';
    end if;
  end loop;
  -- Lock in a consistent order for overlapping/reversed multi-alert batches.
  -- Serializing the missing-row case prevents concurrent retries from creating
  -- an orphan engine_alerts row before the unique receipt becomes visible.
  for v_lock_key in
    select distinct hashtextextended('engine-alert-event:' || (value->'labels'->>'engine_alert_event_id')::uuid::text, 0)
    from jsonb_array_elements(p_alerts)
    where (value->'labels') ? 'engine_alert_event_id'
    order by 1
  loop
    perform pg_advisory_xact_lock(v_lock_key);
  end loop;

  for v_alert in select value from jsonb_array_elements(p_alerts) loop
    v_event_id := (v_alert->'labels'->>'engine_alert_event_id')::uuid;
    if v_event_id is not null then
      select * into v_existing from public.engine_alert_delivery_receipts where event_id = v_event_id;
      if found then
        if v_existing.payload is distinct from v_alert then
          raise exception using errcode = '23505', message = 'Engine event ID already belongs to different payload';
        end if;
        v_receipts := v_receipts || jsonb_build_array(jsonb_build_object('id', v_existing.engine_alert_id, 'event_id', v_event_id));
        continue;
      end if;
    end if;

    insert into public.engine_alerts
      (fingerprint, alertname, severity, component, status, summary, description,
       labels, starts_at, ends_at, notified_via)
    values
      (coalesce(nullif(v_alert->>'fingerprint', ''), (v_alert->'labels'->>'alertname') || '-' || coalesce(v_alert->>'startsAt', '')),
       v_alert->'labels'->>'alertname', coalesce(nullif(v_alert->'labels'->>'severity', ''), 'unknown'),
       v_alert->'labels'->>'component', v_alert->>'status',
       v_alert->'annotations'->>'summary', v_alert->'annotations'->>'description',
       v_alert->'labels', nullif(v_alert->>'startsAt', '')::timestamptz,
       case when v_alert->>'endsAt' like '0001%' then null else nullif(v_alert->>'endsAt', '')::timestamptz end,
       array['codex-inbox']) returning id into v_id;
    if v_event_id is not null then
      insert into public.engine_alert_delivery_receipts(event_id, engine_alert_id, payload)
        values(v_event_id, v_id, v_alert);
    end if;
    v_receipts := v_receipts || jsonb_build_array(jsonb_build_object('id', v_id, 'event_id', v_event_id));
  end loop;
  return v_receipts;
end;
$function$;

SELECT pg_temp.assert_direct_source_authority('2baee523d4b95afa879c230f4a5ff4f0',false);
COMMIT;
