-- FIXTURE ONLY / composition UNRUN. No production installer.
-- Load after owner-notification-coexistence.sql, before direct-intake-installed.sql.
-- Fresh captured engine-only missing catalog and exact missing nonunique indexes.
-- Existing financial/incident/notification definitions remain the real provider.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path=public,pg_catalog;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
-- Same captured catalog and original recorder as the qualified Alerts fixture.
-- Only the allocation guard is adapted to this existing full37 local cluster.
DO $isolated$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR inet_server_addr() IS NOT NULL
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  OR current_setting('session_replication_role')<>'origin'
  OR to_regnamespace('operational_source_intake') IS NOT NULL
  OR to_regclass('public.engine_alerts') IS NOT NULL
  OR to_regclass('public.engine_alert_delivery_receipts') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_record_engine_alerts')
  OR to_regclass('public.operational_alert_events') IS NULL
  OR md5(pg_get_functiondef(to_regprocedure('public.fn_record_operational_alert(text,text,text,text,text,jsonb)')))
     IS DISTINCT FROM '36601e205494e8768f5a1dce09f4a186'
 THEN RAISE EXCEPTION 'direct_intake_fixture_requires_original_isolated_pg17_core';END IF;
 -- Retained schema supplies exactly this unused, unattached serial sequence.
 -- It is neither dropped nor reset; the captured ACL is restored below.
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_sequence s ON s.seqrelid=c.oid
  WHERE c.oid=to_regclass('public.engine_alerts_id_seq') AND c.relowner='postgres'::regrole
   AND c.relkind='S' AND c.relacl IS NULL AND s.seqtypid='bigint'::regtype
   AND s.seqstart=1 AND s.seqincrement=1 AND s.seqmin=1 AND s.seqmax=9223372036854775807
   AND s.seqcache=1 AND NOT s.seqcycle)
  OR EXISTS(SELECT 1 FROM pg_depend WHERE classid='pg_class'::regclass
   AND objid=to_regclass('public.engine_alerts_id_seq') AND refclassid='pg_class'::regclass)
  OR EXISTS(SELECT 1 FROM pg_depend WHERE refclassid='pg_class'::regclass
   AND refobjid=to_regclass('public.engine_alerts_id_seq'))
 THEN RAISE EXCEPTION 'direct_intake_fixture_original_sequence_changed';END IF;
 IF EXISTS(SELECT 1 FROM public.engine_alerts_id_seq WHERE last_value<>1 OR is_called)
 THEN RAISE EXCEPTION 'direct_intake_fixture_original_sequence_used';END IF;
END $isolated$;
CREATE TABLE public.engine_alerts (
  "id" bigint DEFAULT nextval('engine_alerts_id_seq'::regclass) NOT NULL,
  "fingerprint" text NOT NULL,
  "alertname" text NOT NULL,
  "severity" text DEFAULT 'unknown'::text NOT NULL,
  "component" text,
  "status" text DEFAULT 'firing'::text NOT NULL,
  "summary" text,
  "description" text,
  "labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "notified_via" text[] DEFAULT '{}'::text[] NOT NULL
);
ALTER TABLE public.engine_alerts ADD CONSTRAINT "engine_alerts_pkey" PRIMARY KEY (id);
ALTER TABLE public.engine_alerts OWNER TO postgres;
ALTER TABLE public.engine_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.engine_alerts FROM PUBLIC,anon,authenticated,service_role;
GRANT ALL ON public.engine_alerts TO service_role;
CREATE TABLE public.engine_alert_delivery_receipts (
  "event_id" uuid NOT NULL,
  "engine_alert_id" bigint NOT NULL,
  "payload" jsonb NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.engine_alert_delivery_receipts ADD CONSTRAINT "engine_alert_delivery_payload_object" CHECK (jsonb_typeof(payload) = 'object'::text);
ALTER TABLE public.engine_alert_delivery_receipts ADD CONSTRAINT "engine_alert_delivery_receipts_engine_alert_id_fkey" FOREIGN KEY (engine_alert_id) REFERENCES engine_alerts(id) ON DELETE RESTRICT;
ALTER TABLE public.engine_alert_delivery_receipts ADD CONSTRAINT "engine_alert_delivery_receipts_engine_alert_id_key" UNIQUE (engine_alert_id);
ALTER TABLE public.engine_alert_delivery_receipts ADD CONSTRAINT "engine_alert_delivery_receipts_pkey" PRIMARY KEY (event_id);
ALTER TABLE public.engine_alert_delivery_receipts OWNER TO postgres;
ALTER TABLE public.engine_alert_delivery_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.engine_alert_delivery_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.engine_alert_delivery_receipts TO service_role;
DO $$ BEGIN IF to_regclass('public.ca_drift_incidents_pkey') IS NULL THEN EXECUTE 'CREATE UNIQUE INDEX ca_drift_incidents_pkey ON public.ca_drift_incidents USING btree (id)'; ELSIF pg_get_indexdef('public.ca_drift_incidents_pkey'::regclass) IS DISTINCT FROM 'CREATE UNIQUE INDEX ca_drift_incidents_pkey ON public.ca_drift_incidents USING btree (id)' THEN RAISE EXCEPTION 'direct source fixture index differs: ca_drift_incidents_pkey'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.ux_ca_drift_incidents_open_dedupe') IS NULL THEN EXECUTE 'CREATE UNIQUE INDEX ux_ca_drift_incidents_open_dedupe ON public.ca_drift_incidents USING btree (dedupe_key) WHERE (status <> ''resolved''::text)'; ELSIF pg_get_indexdef('public.ux_ca_drift_incidents_open_dedupe'::regclass) IS DISTINCT FROM 'CREATE UNIQUE INDEX ux_ca_drift_incidents_open_dedupe ON public.ca_drift_incidents USING btree (dedupe_key) WHERE (status <> ''resolved''::text)' THEN RAISE EXCEPTION 'direct source fixture index differs: ux_ca_drift_incidents_open_dedupe'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.ix_ca_drift_incidents_open') IS NULL THEN EXECUTE 'CREATE INDEX ix_ca_drift_incidents_open ON public.ca_drift_incidents USING btree (status, detected_at DESC) WHERE (status <> ''resolved''::text)'; ELSIF pg_get_indexdef('public.ix_ca_drift_incidents_open'::regclass) IS DISTINCT FROM 'CREATE INDEX ix_ca_drift_incidents_open ON public.ca_drift_incidents USING btree (status, detected_at DESC) WHERE (status <> ''resolved''::text)' THEN RAISE EXCEPTION 'direct source fixture index differs: ix_ca_drift_incidents_open'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.ix_ca_drift_incidents_club') IS NULL THEN EXECUTE 'CREATE INDEX ix_ca_drift_incidents_club ON public.ca_drift_incidents USING btree (club_id, detected_at DESC)'; ELSIF pg_get_indexdef('public.ix_ca_drift_incidents_club'::regclass) IS DISTINCT FROM 'CREATE INDEX ix_ca_drift_incidents_club ON public.ca_drift_incidents USING btree (club_id, detected_at DESC)' THEN RAISE EXCEPTION 'direct source fixture index differs: ix_ca_drift_incidents_club'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.ca_drift_incidents_alert_id_idx') IS NULL THEN EXECUTE 'CREATE INDEX ca_drift_incidents_alert_id_idx ON public.ca_drift_incidents USING btree (((metadata ->> ''alert_id''::text))) WHERE (metadata ? ''alert_id''::text)'; ELSIF pg_get_indexdef('public.ca_drift_incidents_alert_id_idx'::regclass) IS DISTINCT FROM 'CREATE INDEX ca_drift_incidents_alert_id_idx ON public.ca_drift_incidents USING btree (((metadata ->> ''alert_id''::text))) WHERE (metadata ? ''alert_id''::text)' THEN RAISE EXCEPTION 'direct source fixture index differs: ca_drift_incidents_alert_id_idx'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.ca_drift_incidents_alert_uuid_idx') IS NULL THEN EXECUTE 'CREATE INDEX ca_drift_incidents_alert_uuid_idx ON public.ca_drift_incidents USING btree ((((metadata ->> ''alert_id''::text))::uuid)) WHERE ((metadata ->> ''alert_id''::text) ~ ''^[0-9a-fA-F-]{36}$''::text)'; ELSIF pg_get_indexdef('public.ca_drift_incidents_alert_uuid_idx'::regclass) IS DISTINCT FROM 'CREATE INDEX ca_drift_incidents_alert_uuid_idx ON public.ca_drift_incidents USING btree ((((metadata ->> ''alert_id''::text))::uuid)) WHERE ((metadata ->> ''alert_id''::text) ~ ''^[0-9a-fA-F-]{36}$''::text)' THEN RAISE EXCEPTION 'direct source fixture index differs: ca_drift_incidents_alert_uuid_idx'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.engine_alert_delivery_receipts_pkey') IS NULL THEN EXECUTE 'CREATE UNIQUE INDEX engine_alert_delivery_receipts_pkey ON public.engine_alert_delivery_receipts USING btree (event_id)'; ELSIF pg_get_indexdef('public.engine_alert_delivery_receipts_pkey'::regclass) IS DISTINCT FROM 'CREATE UNIQUE INDEX engine_alert_delivery_receipts_pkey ON public.engine_alert_delivery_receipts USING btree (event_id)' THEN RAISE EXCEPTION 'direct source fixture index differs: engine_alert_delivery_receipts_pkey'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.engine_alert_delivery_receipts_engine_alert_id_key') IS NULL THEN EXECUTE 'CREATE UNIQUE INDEX engine_alert_delivery_receipts_engine_alert_id_key ON public.engine_alert_delivery_receipts USING btree (engine_alert_id)'; ELSIF pg_get_indexdef('public.engine_alert_delivery_receipts_engine_alert_id_key'::regclass) IS DISTINCT FROM 'CREATE UNIQUE INDEX engine_alert_delivery_receipts_engine_alert_id_key ON public.engine_alert_delivery_receipts USING btree (engine_alert_id)' THEN RAISE EXCEPTION 'direct source fixture index differs: engine_alert_delivery_receipts_engine_alert_id_key'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.engine_alerts_pkey') IS NULL THEN EXECUTE 'CREATE UNIQUE INDEX engine_alerts_pkey ON public.engine_alerts USING btree (id)'; ELSIF pg_get_indexdef('public.engine_alerts_pkey'::regclass) IS DISTINCT FROM 'CREATE UNIQUE INDEX engine_alerts_pkey ON public.engine_alerts USING btree (id)' THEN RAISE EXCEPTION 'direct source fixture index differs: engine_alerts_pkey'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.engine_alerts_received_idx') IS NULL THEN EXECUTE 'CREATE INDEX engine_alerts_received_idx ON public.engine_alerts USING btree (received_at DESC)'; ELSIF pg_get_indexdef('public.engine_alerts_received_idx'::regclass) IS DISTINCT FROM 'CREATE INDEX engine_alerts_received_idx ON public.engine_alerts USING btree (received_at DESC)' THEN RAISE EXCEPTION 'direct source fixture index differs: engine_alerts_received_idx'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.engine_alerts_active_idx') IS NULL THEN EXECUTE 'CREATE INDEX engine_alerts_active_idx ON public.engine_alerts USING btree (alertname, status, received_at DESC)'; ELSIF pg_get_indexdef('public.engine_alerts_active_idx'::regclass) IS DISTINCT FROM 'CREATE INDEX engine_alerts_active_idx ON public.engine_alerts USING btree (alertname, status, received_at DESC)' THEN RAISE EXCEPTION 'direct source fixture index differs: engine_alerts_active_idx'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.financial_alerts_pkey') IS NULL THEN EXECUTE 'CREATE UNIQUE INDEX financial_alerts_pkey ON public.financial_alerts USING btree (id)'; ELSIF pg_get_indexdef('public.financial_alerts_pkey'::regclass) IS DISTINCT FROM 'CREATE UNIQUE INDEX financial_alerts_pkey ON public.financial_alerts USING btree (id)' THEN RAISE EXCEPTION 'direct source fixture index differs: financial_alerts_pkey'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.idx_financial_alerts_resolved') IS NULL THEN EXECUTE 'CREATE INDEX idx_financial_alerts_resolved ON public.financial_alerts USING btree (resolved) WHERE (resolved = false)'; ELSIF pg_get_indexdef('public.idx_financial_alerts_resolved'::regclass) IS DISTINCT FROM 'CREATE INDEX idx_financial_alerts_resolved ON public.financial_alerts USING btree (resolved) WHERE (resolved = false)' THEN RAISE EXCEPTION 'direct source fixture index differs: idx_financial_alerts_resolved'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.idx_financial_alerts_severity') IS NULL THEN EXECUTE 'CREATE INDEX idx_financial_alerts_severity ON public.financial_alerts USING btree (severity)'; ELSIF pg_get_indexdef('public.idx_financial_alerts_severity'::regclass) IS DISTINCT FROM 'CREATE INDEX idx_financial_alerts_severity ON public.financial_alerts USING btree (severity)' THEN RAISE EXCEPTION 'direct source fixture index differs: idx_financial_alerts_severity'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.idx_financial_alerts_resolved_by') IS NULL THEN EXECUTE 'CREATE INDEX idx_financial_alerts_resolved_by ON public.financial_alerts USING btree (resolved_by)'; ELSIF pg_get_indexdef('public.idx_financial_alerts_resolved_by'::regclass) IS DISTINCT FROM 'CREATE INDEX idx_financial_alerts_resolved_by ON public.financial_alerts USING btree (resolved_by)' THEN RAISE EXCEPTION 'direct source fixture index differs: idx_financial_alerts_resolved_by'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.idx_financial_alerts_reported_by_created') IS NULL THEN EXECUTE 'CREATE INDEX idx_financial_alerts_reported_by_created ON public.financial_alerts USING btree (((context ->> ''reported_by''::text)), created_at DESC)'; ELSIF pg_get_indexdef('public.idx_financial_alerts_reported_by_created'::regclass) IS DISTINCT FROM 'CREATE INDEX idx_financial_alerts_reported_by_created ON public.financial_alerts USING btree (((context ->> ''reported_by''::text)), created_at DESC)' THEN RAISE EXCEPTION 'direct source fixture index differs: idx_financial_alerts_reported_by_created'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.idx_financial_alerts_source_created') IS NULL THEN EXECUTE 'CREATE INDEX idx_financial_alerts_source_created ON public.financial_alerts USING btree (source, created_at DESC)'; ELSIF pg_get_indexdef('public.idx_financial_alerts_source_created'::regclass) IS DISTINCT FROM 'CREATE INDEX idx_financial_alerts_source_created ON public.financial_alerts USING btree (source, created_at DESC)' THEN RAISE EXCEPTION 'direct source fixture index differs: idx_financial_alerts_source_created'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.financial_alerts_incident_id_idx') IS NULL THEN EXECUTE 'CREATE INDEX financial_alerts_incident_id_idx ON public.financial_alerts USING btree (((context ->> ''incident_id''::text))) WHERE (context ? ''incident_id''::text)'; ELSIF pg_get_indexdef('public.financial_alerts_incident_id_idx'::regclass) IS DISTINCT FROM 'CREATE INDEX financial_alerts_incident_id_idx ON public.financial_alerts USING btree (((context ->> ''incident_id''::text))) WHERE (context ? ''incident_id''::text)' THEN RAISE EXCEPTION 'direct source fixture index differs: financial_alerts_incident_id_idx'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.financial_alerts_unresolved_source_idx') IS NULL THEN EXECUTE 'CREATE INDEX financial_alerts_unresolved_source_idx ON public.financial_alerts USING btree (source) WHERE (NOT resolved)'; ELSIF pg_get_indexdef('public.financial_alerts_unresolved_source_idx'::regclass) IS DISTINCT FROM 'CREATE INDEX financial_alerts_unresolved_source_idx ON public.financial_alerts USING btree (source) WHERE (NOT resolved)' THEN RAISE EXCEPTION 'direct source fixture index differs: financial_alerts_unresolved_source_idx'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.financial_alerts_incident_uuid_idx') IS NULL THEN EXECUTE 'CREATE INDEX financial_alerts_incident_uuid_idx ON public.financial_alerts USING btree ((((context ->> ''incident_id''::text))::uuid)) WHERE ((context ->> ''incident_id''::text) ~ ''^[0-9a-fA-F-]{36}$''::text)'; ELSIF pg_get_indexdef('public.financial_alerts_incident_uuid_idx'::regclass) IS DISTINCT FROM 'CREATE INDEX financial_alerts_incident_uuid_idx ON public.financial_alerts USING btree ((((context ->> ''incident_id''::text))::uuid)) WHERE ((context ->> ''incident_id''::text) ~ ''^[0-9a-fA-F-]{36}$''::text)' THEN RAISE EXCEPTION 'direct source fixture index differs: financial_alerts_incident_uuid_idx'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.operational_alert_events_pkey') IS NULL THEN EXECUTE 'CREATE UNIQUE INDEX operational_alert_events_pkey ON public.operational_alert_events USING btree (id)'; ELSIF pg_get_indexdef('public.operational_alert_events_pkey'::regclass) IS DISTINCT FROM 'CREATE UNIQUE INDEX operational_alert_events_pkey ON public.operational_alert_events USING btree (id)' THEN RAISE EXCEPTION 'direct source fixture index differs: operational_alert_events_pkey'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.operational_alert_events_source_event_key_key') IS NULL THEN EXECUTE 'CREATE UNIQUE INDEX operational_alert_events_source_event_key_key ON public.operational_alert_events USING btree (source, event_key)'; ELSIF pg_get_indexdef('public.operational_alert_events_source_event_key_key'::regclass) IS DISTINCT FROM 'CREATE UNIQUE INDEX operational_alert_events_source_event_key_key ON public.operational_alert_events USING btree (source, event_key)' THEN RAISE EXCEPTION 'direct source fixture index differs: operational_alert_events_source_event_key_key'; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.operational_alert_pending_idx') IS NULL THEN EXECUTE 'CREATE INDEX operational_alert_pending_idx ON public.operational_alert_events USING btree (investigation_status, id)'; ELSIF pg_get_indexdef('public.operational_alert_pending_idx'::regclass) IS DISTINCT FROM 'CREATE INDEX operational_alert_pending_idx ON public.operational_alert_events USING btree (investigation_status, id)' THEN RAISE EXCEPTION 'direct source fixture index differs: operational_alert_pending_idx'; END IF; END $$;
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

ALTER FUNCTION public.fn_record_engine_alerts(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_record_engine_alerts(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_record_engine_alerts(jsonb) TO service_role;
-- Exact sequence authority captured 2026-09-17T05:22:56Z. Existing retained
-- schema already supplies its decimal-text bigint bounds; no sequence reseed.
ALTER SEQUENCE public.engine_alerts_id_seq OWNER TO postgres;
REVOKE ALL ON SEQUENCE public.engine_alerts_id_seq FROM PUBLIC,anon,authenticated,service_role;
GRANT ALL ON SEQUENCE public.engine_alerts_id_seq TO anon,authenticated,service_role;
DO $postimage$ BEGIN
 IF md5(pg_get_functiondef('public.fn_record_engine_alerts(jsonb)'::regprocedure))
      IS DISTINCT FROM '2baee523d4b95afa879c230f4a5ff4f0'
  OR (SELECT proowner FROM pg_proc WHERE oid='public.fn_record_engine_alerts(jsonb)'::regprocedure)<>'postgres'::regrole
  OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a
      WHERE p.oid='public.fn_record_engine_alerts(jsonb)'::regprocedure)
      IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]
  OR has_function_privilege('anon','public.fn_record_engine_alerts(jsonb)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_record_engine_alerts(jsonb)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.fn_record_engine_alerts(jsonb)','EXECUTE')
  OR EXISTS(SELECT 1 FROM public.engine_alerts) OR EXISTS(SELECT 1 FROM public.engine_alert_delivery_receipts)
  OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_class c,LATERAL unnest(c.relacl)a
      WHERE c.oid='public.engine_alerts_id_seq'::regclass)
      IS DISTINCT FROM ARRAY['anon=rwU/postgres','authenticated=rwU/postgres','postgres=rwU/postgres','service_role=rwU/postgres']::text[]
 THEN RAISE EXCEPTION 'direct_intake_fixture_engine_preimage_mismatch';END IF;
END $postimage$;
-- The immediately following byte-identical installed packet validates the full
-- five-relation catalog, policies, trigger dependencies and both recorder ACLs
-- before adding any direct hook. It refuses differences rather than replacing
-- a real financial/incident/notification authority with a stub.
COMMIT;
