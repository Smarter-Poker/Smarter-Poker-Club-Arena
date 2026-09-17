-- Included only by the guarded component. No source row is written by this code.
CREATE SCHEMA operational_source_intake AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA operational_source_intake FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA operational_source_intake TO service_role;
CREATE TABLE operational_source_intake.snapshots (
  snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind text NOT NULL CHECK(source_kind IN ('financial','drift','engine')),
  source_id text NOT NULL,
  snapshot_md5 text NOT NULL,
  original_row jsonb NOT NULL CHECK(jsonb_typeof(original_row)='object'),
  first_observed boolean NOT NULL,
  observation text NOT NULL CHECK(observation IN ('insert','update_old','update_new','replay')),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  target_task_id uuid NOT NULL DEFAULT '01a09b86-5ba8-7290-8657-1041f13dd3ca'
    CHECK(target_task_id='01a09b86-5ba8-7290-8657-1041f13dd3ca'),
  UNIQUE(source_kind,source_id,snapshot_md5),
  CHECK((original_row->>'id'=source_id AND md5(original_row::text)=snapshot_md5) IS TRUE)
);
CREATE UNIQUE INDEX operational_source_first_observed ON operational_source_intake.snapshots(source_kind,source_id) WHERE first_observed;
CREATE TABLE operational_source_intake.deliveries (
  snapshot_id uuid PRIMARY KEY REFERENCES operational_source_intake.snapshots(snapshot_id),
  inbox_event_id bigint REFERENCES public.operational_alert_events(id),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','captured')),
  last_attempt_at timestamptz,
  last_error text,
  CHECK((state='captured')=(inbox_event_id IS NOT NULL)),
  CHECK(state<>'captured' OR last_error IS NULL)
);
ALTER TABLE operational_source_intake.snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_source_intake.deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA operational_source_intake FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON operational_source_intake.snapshots,operational_source_intake.deliveries TO service_role;
CREATE INDEX operational_source_delivery_pending ON operational_source_intake.deliveries(snapshot_id) WHERE state='pending';

CREATE FUNCTION operational_source_intake.immutable_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='operational source snapshot is immutable'; END;
$body$;
REVOKE ALL ON FUNCTION operational_source_intake.immutable_snapshot() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER snapshots_immutable BEFORE UPDATE OR DELETE ON operational_source_intake.snapshots
 FOR EACH ROW EXECUTE FUNCTION operational_source_intake.immutable_snapshot();
CREATE TRIGGER snapshots_no_truncate BEFORE TRUNCATE ON operational_source_intake.snapshots
 FOR EACH STATEMENT EXECUTE FUNCTION operational_source_intake.immutable_snapshot();
CREATE TRIGGER deliveries_no_delete BEFORE DELETE ON operational_source_intake.deliveries
 FOR EACH ROW EXECUTE FUNCTION operational_source_intake.immutable_snapshot();
CREATE TRIGGER deliveries_no_truncate BEFORE TRUNCATE ON operational_source_intake.deliveries
 FOR EACH STATEMENT EXECUTE FUNCTION operational_source_intake.immutable_snapshot();

-- Mapping is exactly the existing finite readers' mapping. Bad source values
-- stay failures/pending; there is no fallback classification or invented name.
CREATE FUNCTION operational_source_intake.mapping(p_kind text,p_row jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $body$
DECLARE v_id text; v_name text; v_status text; v_severity text; v_prefix text; v_field text;
BEGIN
  IF jsonb_typeof(p_row) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'source snapshot is not an object'; END IF;
  v_id:=p_row->>'id'; v_severity:=p_row->>'severity';
  IF p_kind='engine' THEN
    IF jsonb_typeof(p_row->'id') IS DISTINCT FROM 'number' OR v_id IS NULL OR v_id !~ '^-?(0|[1-9][0-9]*)$' OR v_id::bigint::text IS DISTINCT FROM v_id THEN RAISE EXCEPTION 'engine source identity is invalid'; END IF;
    v_name:=p_row->>'alertname'; v_status:=p_row->>'status'; v_prefix:='engine-alerts'; v_field:='original_event';
  ELSIF p_kind IN ('financial','drift') THEN
    IF v_id IS NULL OR v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN RAISE EXCEPTION 'financial source identity is invalid'; END IF;
    v_name:=left(p_row->>'source',240);
    IF p_kind='financial' THEN
      IF jsonb_typeof(p_row->'resolved') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'financial source resolved is invalid'; END IF;
      v_status:=CASE WHEN p_row->>'resolved'='true' THEN 'resolved' ELSE 'firing' END;
      v_prefix:='financial-alerts'; v_field:='original_event';
    ELSE
      IF p_row->>'status' IS NULL THEN RAISE EXCEPTION 'drift source status is absent'; END IF;
      v_status:=CASE WHEN p_row->>'status'='resolved' THEN 'resolved' ELSE 'firing' END;
      v_prefix:='drift-incidents'; v_field:='original_incident';
    END IF;
  ELSE RAISE EXCEPTION 'unsupported operational source'; END IF;
  IF v_name IS NULL OR length(v_name) NOT BETWEEN 1 AND 240 OR v_status IS NULL
    OR (v_status NOT IN ('firing','resolved') AND NOT (p_kind='engine' AND v_status='info')) OR v_severity IS NULL OR length(v_severity) NOT BETWEEN 1 AND 40
    THEN RAISE EXCEPTION 'source classification is invalid'; END IF;
  RETURN jsonb_build_object('id',v_id,'name',v_name,'status',v_status,'severity',v_severity,'prefix',v_prefix,'field',v_field);
END;
$body$;
REVOKE ALL ON FUNCTION operational_source_intake.mapping(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION operational_source_intake.reference(p_snapshot_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $body$
 SELECT jsonb_build_object('format','operational-source-row-v1','snapshot_id',s.snapshot_id,
   'source_kind',s.source_kind,'source_id',s.source_id,'snapshot_md5',s.snapshot_md5,
   'snapshot_bytes',octet_length(s.original_row::text))
 FROM operational_source_intake.snapshots s WHERE snapshot_id=p_snapshot_id;
$body$;
REVOKE ALL ON FUNCTION operational_source_intake.reference(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- A reference is accepted only after resolving its entire immutable descriptor.
-- JSON equality, not a digest alone, is used at the receipt boundary below.
CREATE FUNCTION operational_source_intake.receipt_row(p_event public.operational_alert_events,p_kind text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $body$
DECLARE v_row jsonb; m jsonb; s operational_source_intake.snapshots%ROWTYPE; ref jsonb;
BEGIN
  IF p_event.payload->>'target_task_id' IS NULL THEN
    -- Compatibility is only the retained finite-reader envelope. New capture
    -- markers or reference envelopes can never use absent task as acceptance.
    IF jsonb_typeof(p_event.payload->'captured_at') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p_event.payload->'backfill_window_start') IS DISTINCT FROM 'string'
      OR (p_event.payload ? 'snapshot_kind' AND p_event.payload->>'snapshot_kind' IS DISTINCT FROM 'source_row_changed')
      OR p_event.payload ? 'evidence_reference'
      THEN RAISE EXCEPTION 'operational source task is missing outside retained legacy envelope'; END IF;
  ELSIF p_event.payload->>'target_task_id'<>'01a09b86-5ba8-7290-8657-1041f13dd3ca' THEN
    RAISE EXCEPTION 'operational source task collision';
  END IF;
  IF p_event.payload ? 'evidence_reference' THEN
    IF p_event.payload ? 'original_event' OR p_event.payload ? 'original_incident'
      OR p_event.payload->>'evidence_storage' IS DISTINCT FROM 'immutable_reference'
      THEN RAISE EXCEPTION 'ambiguous operational source reference'; END IF;
    ref:=p_event.payload->'evidence_reference';
    SELECT * INTO STRICT s FROM operational_source_intake.snapshots WHERE snapshot_id=(ref->>'snapshot_id')::uuid;
    IF s.source_kind IS DISTINCT FROM p_kind OR ref IS DISTINCT FROM operational_source_intake.reference(s.snapshot_id)
      OR p_event.payload->>'target_task_id' IS DISTINCT FROM s.target_task_id::text
      THEN RAISE EXCEPTION 'operational source reference mismatch'; END IF;
    v_row:=s.original_row;
  ELSE
    v_row:=p_event.payload->(CASE WHEN p_kind='drift' THEN 'original_incident' ELSE 'original_event' END);
  END IF;
  m:=operational_source_intake.mapping(p_kind,v_row);
  IF p_event.alertname IS DISTINCT FROM m->>'name' OR p_event.status IS DISTINCT FROM m->>'status'
    OR p_event.severity IS DISTINCT FROM m->>'severity'
    OR NOT ((p_event.source=(m->>'prefix')||'-backfill' AND p_event.event_key=m->>'id')
       OR (p_event.source=(m->>'prefix')||'-updates' AND p_event.event_key=(m->>'id')||':'||md5(v_row::text)))
    THEN RAISE EXCEPTION 'operational source receipt classification or identity collision'; END IF;
  RETURN v_row;
END;
$body$;
REVOKE ALL ON FUNCTION operational_source_intake.receipt_row(public.operational_alert_events,text) FROM PUBLIC,anon,authenticated,service_role;

-- Caller owns the source row (row trigger or engine replay FOR UPDATE).
-- This never reacquires source locks after acquiring an inbox lock. Existing
-- finite readers acquire inbox keys only, so no reverse lock edge is added.
CREATE FUNCTION operational_source_intake.record_strict(p_kind text,p_row jsonb,p_observation text,p_snapshot_id uuid DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
DECLARE m jsonb; v_original public.operational_alert_events%ROWTYPE; e public.operational_alert_events%ROWTYPE;
  v_old jsonb; v_source text; v_key text; v_payload jsonb; v_id bigint; v_original_id bigint;
  v_snapshot_id uuid:=p_snapshot_id; v_stored jsonb;
BEGIN
  m:=operational_source_intake.mapping(p_kind,p_row);
  v_source:=(m->>'prefix')||'-backfill'; v_key:=m->>'id';
  SELECT * INTO v_original FROM public.operational_alert_events WHERE source=v_source AND event_key=v_key;
  IF FOUND THEN
    v_old:=operational_source_intake.receipt_row(v_original,p_kind);
    IF v_old=p_row THEN RETURN v_original.id; END IF;
    IF p_observation='insert' THEN RAISE EXCEPTION 'operational source original snapshot collision'; END IF;
    v_original_id:=v_original.id; v_source:=(m->>'prefix')||'-updates'; v_key:=(m->>'id')||':'||md5(p_row::text);
  END IF;
  IF v_original.id IS NULL AND p_snapshot_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM operational_source_intake.snapshots WHERE snapshot_id=p_snapshot_id AND first_observed)
    THEN RAISE EXCEPTION 'operational source first observed snapshot is still pending'; END IF;
  IF v_original_id IS NOT NULL THEN
    SELECT * INTO e FROM public.operational_alert_events WHERE source=v_source AND event_key=v_key;
    IF FOUND THEN
      IF operational_source_intake.receipt_row(e,p_kind) IS DISTINCT FROM p_row
        OR e.payload->>'original_inbox_id' IS DISTINCT FROM v_original_id::text
        THEN RAISE EXCEPTION 'operational source existing update receipt collision'; END IF;
      RETURN e.id;
    END IF;
  END IF;
  v_payload:=jsonb_build_object(m->>'field',p_row,'target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca',
    'captured_at',clock_timestamp(),'snapshot_kind',p_observation);
  IF v_original_id IS NOT NULL THEN v_payload:=v_payload||jsonb_build_object('original_inbox_id',v_original_id); END IF;
  IF octet_length(v_payload::text)>262144 THEN
    IF v_snapshot_id IS NULL AND p_kind='engine' THEN
      -- A valid producer batch can expand when fields are copied into the source
      -- row/envelope. Preserve its full row without changing the inbox limit.
      -- This path has no exception handler: storage/capture failure aborts the
      -- entire engine transaction and never acknowledges only a producer ID.
      INSERT INTO operational_source_intake.snapshots(source_kind,source_id,snapshot_md5,original_row,first_observed,observation)
      VALUES(p_kind,m->>'id',md5(p_row::text),p_row,
        NOT EXISTS(SELECT 1 FROM operational_source_intake.snapshots WHERE source_kind=p_kind AND source_id=m->>'id'),p_observation)
      ON CONFLICT(source_kind,source_id,snapshot_md5) DO NOTHING RETURNING snapshot_id INTO v_snapshot_id;
      IF v_snapshot_id IS NULL THEN
        SELECT snapshot_id,original_row INTO STRICT v_snapshot_id,v_stored FROM operational_source_intake.snapshots
          WHERE source_kind=p_kind AND source_id=m->>'id' AND snapshot_md5=md5(p_row::text);
        IF v_stored IS DISTINCT FROM p_row THEN RAISE EXCEPTION 'operational source snapshot digest collision'; END IF;
      ELSE
        INSERT INTO operational_source_intake.deliveries(snapshot_id) VALUES(v_snapshot_id);
      END IF;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM operational_source_intake.snapshots s WHERE snapshot_id=v_snapshot_id
      AND s.source_kind=p_kind AND s.original_row=p_row) THEN RAISE EXCEPTION 'operational source reference snapshot mismatch'; END IF;
    v_payload:=(v_payload-(m->>'field'))||jsonb_build_object('evidence_storage','immutable_reference',
      'evidence_reference',operational_source_intake.reference(v_snapshot_id));
  END IF;
  v_id:=public.fn_record_operational_alert(v_source,v_key,m->>'name',m->>'status',m->>'severity',v_payload);
  SELECT * INTO STRICT e FROM public.operational_alert_events WHERE id=v_id;
  -- A finite reader may have won the absent-original race. Accept only the
  -- exact same snapshot here; a differing winner is pending/failure, not an ACK.
  IF e.source IS DISTINCT FROM v_source OR e.event_key IS DISTINCT FROM v_key
    OR e.payload->>'target_task_id' IS DISTINCT FROM '01a09b86-5ba8-7290-8657-1041f13dd3ca'
    OR operational_source_intake.receipt_row(e,p_kind) IS DISTINCT FROM p_row
    OR (v_original_id IS NOT NULL AND e.payload->>'original_inbox_id' IS DISTINCT FROM v_original_id::text)
    THEN RAISE EXCEPTION 'operational source exact receipt collision'; END IF;
  IF p_kind='engine' AND v_snapshot_id IS NOT NULL THEN
    UPDATE operational_source_intake.deliveries SET state='captured',inbox_event_id=v_id,
      last_attempt_at=clock_timestamp(),last_error=NULL WHERE snapshot_id=v_snapshot_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'operational source engine delivery state is missing'; END IF;
  END IF;
  RETURN v_id;
END;
$body$;
REVOKE ALL ON FUNCTION operational_source_intake.record_strict(text,jsonb,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION operational_source_intake.try_delivery(p_snapshot_id uuid)
RETURNS bigint LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
DECLARE s operational_source_intake.snapshots%ROWTYPE; v_id bigint;
BEGIN
  SELECT * INTO STRICT s FROM operational_source_intake.snapshots WHERE snapshot_id=p_snapshot_id;
  PERFORM 1 FROM operational_source_intake.deliveries WHERE snapshot_id=p_snapshot_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operational source delivery state is missing'; END IF;
  BEGIN
    v_id:=operational_source_intake.record_strict(s.source_kind,s.original_row,s.observation,s.snapshot_id);
    UPDATE operational_source_intake.deliveries SET inbox_event_id=v_id,state='captured',
      last_attempt_at=clock_timestamp(),last_error=NULL WHERE snapshot_id=p_snapshot_id;
    RETURN v_id;
  EXCEPTION WHEN OTHERS THEN
    UPDATE operational_source_intake.deliveries SET inbox_event_id=NULL,state='pending',
      last_attempt_at=clock_timestamp(),last_error=SQLSTATE||':'||left(SQLERRM,1000) WHERE snapshot_id=p_snapshot_id;
    RETURN NULL;
  END;
END;
$body$;
REVOKE ALL ON FUNCTION operational_source_intake.try_delivery(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION operational_source_intake.preserve(p_kind text,p_row jsonb,p_observation text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
DECLARE s operational_source_intake.snapshots%ROWTYPE; v_id uuid;
BEGIN
  INSERT INTO operational_source_intake.snapshots(source_kind,source_id,snapshot_md5,original_row,observation,first_observed)
    VALUES(p_kind,p_row->>'id',md5(p_row::text),p_row,p_observation,
      NOT EXISTS(SELECT 1 FROM operational_source_intake.snapshots WHERE source_kind=p_kind AND source_id=p_row->>'id'))
    ON CONFLICT(source_kind,source_id,snapshot_md5) DO NOTHING RETURNING snapshot_id INTO v_id;
  IF v_id IS NULL THEN
    SELECT * INTO STRICT s FROM operational_source_intake.snapshots
      WHERE source_kind=p_kind AND source_id=p_row->>'id' AND snapshot_md5=md5(p_row::text);
    IF s.original_row IS DISTINCT FROM p_row THEN RAISE EXCEPTION 'operational source snapshot digest collision'; END IF;
    v_id:=s.snapshot_id;
  ELSE
    INSERT INTO operational_source_intake.deliveries(snapshot_id) VALUES(v_id);
  END IF;
  PERFORM operational_source_intake.try_delivery(v_id);
EXCEPTION WHEN OTHERS THEN
  -- Storage itself is not infallible. Preserve the original money/source result,
  -- emit the existing PostgreSQL diagnostic, and never claim a durable receipt.
  -- Ordinary OTHERS does not swallow query cancellation or server shutdown.
  RAISE WARNING 'operational source capture failed kind=% id=% snapshot=% SQLSTATE=%: %',
    p_kind,p_row->>'id',md5(p_row::text),SQLSTATE,left(SQLERRM,1000);
END;
$body$;
REVOKE ALL ON FUNCTION operational_source_intake.preserve(text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;

-- Serialize timestamps under a fixed observation zone without changing the
-- original recorder's timestamp parsing or financial caller configuration.
CREATE FUNCTION operational_source_intake.record_engine(p_row public.engine_alerts,p_observation text)
RETURNS bigint LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $body$
BEGIN RETURN operational_source_intake.record_strict('engine',to_jsonb(p_row),p_observation); END;
$body$;
REVOKE ALL ON FUNCTION operational_source_intake.record_engine(public.engine_alerts,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_capture_operational_source_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $body$
DECLARE k text;
BEGIN
  IF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME NOT IN ('engine_alerts','financial_alerts','ca_drift_incidents')
    OR TG_OP NOT IN ('INSERT','UPDATE') OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
    THEN RAISE EXCEPTION 'invalid operational source trigger binding'; END IF;
  k:=CASE TG_TABLE_NAME WHEN 'engine_alerts' THEN 'engine' WHEN 'financial_alerts' THEN 'financial' ELSE 'drift' END;
  IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW; END IF;
  IF k='engine' THEN
    IF TG_OP='UPDATE' THEN PERFORM operational_source_intake.record_strict(k,to_jsonb(OLD),'update_old'); END IF;
    PERFORM operational_source_intake.record_strict(k,to_jsonb(NEW),CASE WHEN TG_OP='INSERT' THEN 'insert' ELSE 'update_new' END);
  ELSE
    IF TG_OP='UPDATE' THEN PERFORM operational_source_intake.preserve(k,to_jsonb(OLD),'update_old'); END IF;
    PERFORM operational_source_intake.preserve(k,to_jsonb(NEW),CASE WHEN TG_OP='INSERT' THEN 'insert' ELSE 'update_new' END);
  END IF;
  RETURN NEW;
END;
$body$;
REVOKE ALL ON FUNCTION public.fn_capture_operational_source_event() FROM PUBLIC,anon,authenticated,service_role;
-- AFTER ordering is alphabetical. These precede the captured t*/zz* projection
-- triggers, while all existing BEFORE scope/resolution guards still run first.
CREATE TRIGGER a00_operational_source_intake AFTER INSERT OR UPDATE ON public.engine_alerts
 FOR EACH ROW EXECUTE FUNCTION public.fn_capture_operational_source_event();
CREATE TRIGGER a00_operational_source_intake AFTER INSERT OR UPDATE ON public.financial_alerts
 FOR EACH ROW EXECUTE FUNCTION public.fn_capture_operational_source_event();
CREATE TRIGGER a00_operational_source_intake AFTER INSERT OR UPDATE ON public.ca_drift_incidents
 FOR EACH ROW EXECUTE FUNCTION public.fn_capture_operational_source_event();

-- Explicit finite owner action for one exact retained identity. No schedule,
-- source writes, new event identities, or financial replay is introduced.
CREATE FUNCTION public.fn_retry_operational_source_snapshot(p_snapshot_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE d operational_source_intake.deliveries%ROWTYPE;
BEGIN
  PERFORM operational_source_intake.try_delivery(p_snapshot_id);
  SELECT * INTO STRICT d FROM operational_source_intake.deliveries WHERE snapshot_id=p_snapshot_id;
  RETURN jsonb_build_object('snapshot_id',p_snapshot_id,'state',d.state,'inbox_event_id',d.inbox_event_id,
    'last_error',d.last_error,'target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca');
END;
$body$;
REVOKE ALL ON FUNCTION public.fn_retry_operational_source_snapshot(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_retry_operational_source_snapshot(uuid) TO service_role;

CREATE FUNCTION public.fn_read_operational_source_snapshot(p_inbox_event_id bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE e public.operational_alert_events%ROWTYPE; k text;
BEGIN
  SELECT * INTO STRICT e FROM public.operational_alert_events WHERE id=p_inbox_event_id;
  k:=CASE WHEN e.source IN ('financial-alerts-backfill','financial-alerts-updates') THEN 'financial'
    WHEN e.source IN ('drift-incidents-backfill','drift-incidents-updates') THEN 'drift'
    WHEN e.source IN ('engine-alerts-backfill','engine-alerts-updates') THEN 'engine' END;
  IF k IS NULL THEN RAISE EXCEPTION 'not an operational source receipt'; END IF;
  RETURN operational_source_intake.receipt_row(e,k);
END;
$body$;
REVOKE ALL ON FUNCTION public.fn_read_operational_source_snapshot(bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_read_operational_source_snapshot(bigint) TO service_role;
