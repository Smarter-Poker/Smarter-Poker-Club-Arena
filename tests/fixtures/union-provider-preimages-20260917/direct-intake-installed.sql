-- SOURCE ONLY / UNRUN. First install only; an existing namespace refuses replay.
-- Explicit owner DDL serialization and the native gate are required; this file
-- does not grant either. No notification mirror or financial writer is changed.
BEGIN;
SET LOCAL search_path=public,pg_catalog;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
LOCK TABLE public.ca_drift_incidents,public.engine_alert_delivery_receipts,
 public.engine_alerts,public.financial_alerts,public.operational_alert_events IN SHARE ROW EXCLUSIVE MODE;
-- Fresh catalog 2026-09-17T05:16:36Z; source capture retained in qualification authority.json.
-- This is a transaction-local assertion, not a DDL serialization permit.
-- External owner exclusion of target/dependency DDL must cover check, install,
-- and readback. Relation locks alone do not serialize CREATE OR REPLACE FUNCTION.
CREATE OR REPLACE FUNCTION pg_temp.assert_direct_source_authority(p_engine_md5 text,p_post boolean)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_catalog AS $guard$
DECLARE actual jsonb; expected jsonb := $authority${"functions":[{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=pg_catalog"],"secdef":true,"signature":"fn_record_engine_alerts(jsonb)","definition_md5":"2baee523d4b95afa879c230f4a5ff4f0"},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=pg_catalog, public"],"secdef":false,"signature":"fn_record_operational_alert(text,text,text,text,text,jsonb)","definition_md5":"36601e205494e8768f5a1dce09f4a186"}],"relations":[{"acl":"{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}","rls":true,"kind":"r","name":"ca_drift_incidents","owner":"postgres","columns":[{"name":"id","type":"uuid","default":"gen_random_uuid()","identity":"","not_null":true,"generated":""},{"name":"detected_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":true,"generated":""},{"name":"deadline_at","type":"timestamp with time zone","default":"(now() + '00:20:00'::interval)","identity":"","not_null":true,"generated":""},{"name":"classification","type":"text","default":"'unknown'::text","identity":"","not_null":true,"generated":""},{"name":"severity","type":"text","default":"'critical'::text","identity":"","not_null":true,"generated":""},{"name":"layer","type":"text","default":"'unknown'::text","identity":"","not_null":true,"generated":""},{"name":"status","type":"text","default":"'open'::text","identity":"","not_null":true,"generated":""},{"name":"source","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"dedupe_key","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"union_id","type":"uuid","default":null,"identity":"","not_null":false,"generated":""},{"name":"club_id","type":"uuid","default":null,"identity":"","not_null":false,"generated":""},{"name":"entity_type","type":"text","default":null,"identity":"","not_null":false,"generated":""},{"name":"entity_id","type":"uuid","default":null,"identity":"","not_null":false,"generated":""},{"name":"table_id","type":"uuid","default":null,"identity":"","not_null":false,"generated":""},{"name":"tournament_id","type":"uuid","default":null,"identity":"","not_null":false,"generated":""},{"name":"hand_id","type":"uuid","default":null,"identity":"","not_null":false,"generated":""},{"name":"settlement_id","type":"text","default":null,"identity":"","not_null":false,"generated":""},{"name":"wallet_ids","type":"uuid[]","default":null,"identity":"","not_null":false,"generated":""},{"name":"transaction_ids","type":"uuid[]","default":null,"identity":"","not_null":false,"generated":""},{"name":"currency","type":"text","default":"'club_chips'::text","identity":"","not_null":true,"generated":""},{"name":"expected_amount","type":"numeric","default":null,"identity":"","not_null":false,"generated":""},{"name":"actual_amount","type":"numeric","default":null,"identity":"","not_null":false,"generated":""},{"name":"discrepancy_amount","type":"numeric","default":"0","identity":"","not_null":true,"generated":""},{"name":"ledger_balanced","type":"boolean","default":null,"identity":"","not_null":false,"generated":""},{"name":"suspected_cause","type":"text","default":null,"identity":"","not_null":false,"generated":""},{"name":"auto_repair_status","type":"text","default":"'pending'::text","identity":"","not_null":true,"generated":""},{"name":"escalation_level","type":"integer","default":"0","identity":"","not_null":true,"generated":""},{"name":"past_target","type":"boolean","default":"false","identity":"","not_null":true,"generated":""},{"name":"occurrences","type":"integer","default":"1","identity":"","not_null":true,"generated":""},{"name":"last_seen_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":true,"generated":""},{"name":"acknowledged_by","type":"uuid","default":null,"identity":"","not_null":false,"generated":""},{"name":"acknowledged_at","type":"timestamp with time zone","default":null,"identity":"","not_null":false,"generated":""},{"name":"assigned_to","type":"uuid","default":null,"identity":"","not_null":false,"generated":""},{"name":"root_cause","type":"text","default":null,"identity":"","not_null":false,"generated":""},{"name":"correction_ref","type":"text","default":null,"identity":"","not_null":false,"generated":""},{"name":"resolution","type":"text","default":null,"identity":"","not_null":false,"generated":""},{"name":"resolved_by","type":"uuid","default":null,"identity":"","not_null":false,"generated":""},{"name":"resolved_at","type":"timestamp with time zone","default":null,"identity":"","not_null":false,"generated":""},{"name":"metadata","type":"jsonb","default":"'{}'::jsonb","identity":"","not_null":true,"generated":""},{"name":"created_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":true,"generated":""}],"indexes":["CREATE INDEX ca_drift_incidents_alert_id_idx ON public.ca_drift_incidents USING btree (((metadata ->> 'alert_id'::text))) WHERE (metadata ? 'alert_id'::text)","CREATE INDEX ca_drift_incidents_alert_uuid_idx ON public.ca_drift_incidents USING btree ((((metadata ->> 'alert_id'::text))::uuid)) WHERE ((metadata ->> 'alert_id'::text) ~ '^[0-9a-fA-F-]{36}$'::text)","CREATE INDEX ix_ca_drift_incidents_club ON public.ca_drift_incidents USING btree (club_id, detected_at DESC)","CREATE INDEX ix_ca_drift_incidents_open ON public.ca_drift_incidents USING btree (status, detected_at DESC) WHERE (status <> 'resolved'::text)","CREATE UNIQUE INDEX ca_drift_incidents_pkey ON public.ca_drift_incidents USING btree (id)","CREATE UNIQUE INDEX ux_ca_drift_incidents_open_dedupe ON public.ca_drift_incidents USING btree (dedupe_key) WHERE (status <> 'resolved'::text)"],"policies":null,"triggers":[{"name":"trg_ca_incidents_stay_in_midway","enabled":"O","function":"fn_ca_incidents_stay_in_midway()","definition":"CREATE TRIGGER trg_ca_incidents_stay_in_midway BEFORE INSERT ON ca_drift_incidents FOR EACH ROW EXECUTE FUNCTION fn_ca_incidents_stay_in_midway()","function_acl":"{postgres=X/postgres,service_role=X/postgres}","function_owner":"postgres","function_config":["search_path=public"],"function_secdef":true,"function_definition_md5":"9811b6bdbe53ceb9bdfb2d3ab3096364"},{"name":"trg_ca_resolution_needs_a_cause","enabled":"O","function":"fn_ca_resolution_needs_a_cause()","definition":"CREATE TRIGGER trg_ca_resolution_needs_a_cause BEFORE UPDATE ON ca_drift_incidents FOR EACH ROW EXECUTE FUNCTION fn_ca_resolution_needs_a_cause()","function_acl":"{postgres=X/postgres,service_role=X/postgres}","function_owner":"postgres","function_config":["search_path=public"],"function_secdef":true,"function_definition_md5":"6c7dcd8c415422750cc946887be8d2c7"},{"name":"zz_ca_incident_resolution_reaches_the_alerts","enabled":"O","function":"fn_ca_incident_resolution_reaches_the_alerts()","definition":"CREATE TRIGGER zz_ca_incident_resolution_reaches_the_alerts AFTER UPDATE OF status ON ca_drift_incidents FOR EACH ROW EXECUTE FUNCTION fn_ca_incident_resolution_reaches_the_alerts()","function_acl":"{postgres=X/postgres,service_role=X/postgres}","function_owner":"postgres","function_config":["search_path=public"],"function_secdef":true,"function_definition_md5":"17c6d9a34489d5b1581c2715da03f4ab"}],"force_rls":false,"constraints":[{"name":"ca_drift_incidents_auto_repair_status_check","type":"c","validated":true,"definition":"CHECK (auto_repair_status = ANY (ARRAY['pending'::text, 'running'::text, 'repaired'::text, 'manual_needed'::text, 'not_applicable'::text]))"},{"name":"ca_drift_incidents_classification_check","type":"c","validated":true,"definition":"CHECK (classification = ANY (ARRAY['ledger_imbalance'::text, 'settlement_error'::text, 'duplicate_payment'::text, 'missing_payment'::text, 'projection_delay'::text, 'cache_mismatch'::text, 'reporting_mismatch'::text, 'delayed_event'::text, 'duplicate_event'::text, 'rounding_error'::text, 'incorrect_rake'::text, 'incorrect_weighted_rake'::text, 'incorrect_rakeback'::text, 'bbj_error'::text, 'treasury_error'::text, 'credit_line_error'::text, 'cross_club_posting'::text, 'cross_union_posting'::text, 'unauthorized_adjustment'::text, 'historical_migration'::text, 'unknown'::text]))"},{"name":"ca_drift_incidents_layer_check","type":"c","validated":true,"definition":"CHECK (layer = ANY (ARRAY['ledger'::text, 'projection'::text, 'cache'::text, 'reporting'::text, 'settlement'::text, 'unknown'::text]))"},{"name":"ca_drift_incidents_pkey","type":"p","validated":true,"definition":"PRIMARY KEY (id)"},{"name":"ca_drift_incidents_severity_check","type":"c","validated":true,"definition":"CHECK (severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text]))"},{"name":"ca_drift_incidents_status_check","type":"c","validated":true,"definition":"CHECK (status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'reconciling'::text, 'resolved'::text]))"}],"postgres_trigger_privilege":true},{"acl":"{postgres=arwdDxtm/postgres,service_role=r/postgres}","rls":true,"kind":"r","name":"engine_alert_delivery_receipts","owner":"postgres","columns":[{"name":"event_id","type":"uuid","default":null,"identity":"","not_null":true,"generated":""},{"name":"engine_alert_id","type":"bigint","default":null,"identity":"","not_null":true,"generated":""},{"name":"payload","type":"jsonb","default":null,"identity":"","not_null":true,"generated":""},{"name":"received_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":true,"generated":""}],"indexes":["CREATE UNIQUE INDEX engine_alert_delivery_receipts_engine_alert_id_key ON public.engine_alert_delivery_receipts USING btree (engine_alert_id)","CREATE UNIQUE INDEX engine_alert_delivery_receipts_pkey ON public.engine_alert_delivery_receipts USING btree (event_id)"],"policies":null,"triggers":null,"force_rls":false,"constraints":[{"name":"engine_alert_delivery_payload_object","type":"c","validated":true,"definition":"CHECK (jsonb_typeof(payload) = 'object'::text)"},{"name":"engine_alert_delivery_receipts_engine_alert_id_fkey","type":"f","validated":true,"definition":"FOREIGN KEY (engine_alert_id) REFERENCES engine_alerts(id) ON DELETE RESTRICT"},{"name":"engine_alert_delivery_receipts_engine_alert_id_key","type":"u","validated":true,"definition":"UNIQUE (engine_alert_id)"},{"name":"engine_alert_delivery_receipts_pkey","type":"p","validated":true,"definition":"PRIMARY KEY (event_id)"}],"postgres_trigger_privilege":true},{"acl":"{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}","rls":true,"kind":"r","name":"engine_alerts","owner":"postgres","columns":[{"name":"id","type":"bigint","default":"nextval('engine_alerts_id_seq'::regclass)","identity":"","not_null":true,"generated":""},{"name":"fingerprint","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"alertname","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"severity","type":"text","default":"'unknown'::text","identity":"","not_null":true,"generated":""},{"name":"component","type":"text","default":null,"identity":"","not_null":false,"generated":""},{"name":"status","type":"text","default":"'firing'::text","identity":"","not_null":true,"generated":""},{"name":"summary","type":"text","default":null,"identity":"","not_null":false,"generated":""},{"name":"description","type":"text","default":null,"identity":"","not_null":false,"generated":""},{"name":"labels","type":"jsonb","default":"'{}'::jsonb","identity":"","not_null":true,"generated":""},{"name":"starts_at","type":"timestamp with time zone","default":null,"identity":"","not_null":false,"generated":""},{"name":"ends_at","type":"timestamp with time zone","default":null,"identity":"","not_null":false,"generated":""},{"name":"received_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":true,"generated":""},{"name":"notified_via","type":"text[]","default":"'{}'::text[]","identity":"","not_null":true,"generated":""}],"indexes":["CREATE INDEX engine_alerts_active_idx ON public.engine_alerts USING btree (alertname, status, received_at DESC)","CREATE INDEX engine_alerts_received_idx ON public.engine_alerts USING btree (received_at DESC)","CREATE UNIQUE INDEX engine_alerts_pkey ON public.engine_alerts USING btree (id)"],"policies":null,"triggers":null,"force_rls":false,"constraints":[{"name":"engine_alerts_pkey","type":"p","validated":true,"definition":"PRIMARY KEY (id)"}],"postgres_trigger_privilege":true},{"acl":"{postgres=arwdDxtm/postgres,anon=rxt/postgres,authenticated=rxt/postgres,service_role=arwdDxtm/postgres}","rls":true,"kind":"r","name":"financial_alerts","owner":"postgres","columns":[{"name":"id","type":"uuid","default":"gen_random_uuid()","identity":"","not_null":true,"generated":""},{"name":"severity","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"source","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"message","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"context","type":"jsonb","default":"'{}'::jsonb","identity":"","not_null":false,"generated":""},{"name":"resolved","type":"boolean","default":"false","identity":"","not_null":true,"generated":""},{"name":"resolved_at","type":"timestamp with time zone","default":null,"identity":"","not_null":false,"generated":""},{"name":"created_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":true,"generated":""},{"name":"resolved_by","type":"uuid","default":null,"identity":"","not_null":false,"generated":""},{"name":"resolution","type":"text","default":null,"identity":"","not_null":false,"generated":""}],"indexes":["CREATE INDEX financial_alerts_incident_id_idx ON public.financial_alerts USING btree (((context ->> 'incident_id'::text))) WHERE (context ? 'incident_id'::text)","CREATE INDEX financial_alerts_incident_uuid_idx ON public.financial_alerts USING btree ((((context ->> 'incident_id'::text))::uuid)) WHERE ((context ->> 'incident_id'::text) ~ '^[0-9a-fA-F-]{36}$'::text)","CREATE INDEX financial_alerts_unresolved_source_idx ON public.financial_alerts USING btree (source) WHERE (NOT resolved)","CREATE INDEX idx_financial_alerts_reported_by_created ON public.financial_alerts USING btree (((context ->> 'reported_by'::text)), created_at DESC)","CREATE INDEX idx_financial_alerts_resolved ON public.financial_alerts USING btree (resolved) WHERE (resolved = false)","CREATE INDEX idx_financial_alerts_resolved_by ON public.financial_alerts USING btree (resolved_by)","CREATE INDEX idx_financial_alerts_severity ON public.financial_alerts USING btree (severity)","CREATE INDEX idx_financial_alerts_source_created ON public.financial_alerts USING btree (source, created_at DESC)","CREATE UNIQUE INDEX financial_alerts_pkey ON public.financial_alerts USING btree (id)"],"policies":[{"name":"financial_alerts_service_only","check":"true","roles":["service_role"],"using":"true","command":"*","permissive":true}],"triggers":[{"name":"trg_ca_financial_alert_incident","enabled":"O","function":"fn_ca_financial_alert_to_incident()","definition":"CREATE TRIGGER trg_ca_financial_alert_incident AFTER INSERT ON financial_alerts FOR EACH ROW EXECUTE FUNCTION fn_ca_financial_alert_to_incident()","function_acl":"{postgres=X/postgres,service_role=X/postgres}","function_owner":"postgres","function_config":["search_path=public"],"function_secdef":true,"function_definition_md5":"00a43ae03ab12cec9505e2bfed71d937"},{"name":"zz_ca_alert_resolution_reaches_the_incident","enabled":"O","function":"fn_ca_alert_resolution_reaches_the_incident()","definition":"CREATE TRIGGER zz_ca_alert_resolution_reaches_the_incident AFTER UPDATE OF resolved ON financial_alerts FOR EACH ROW EXECUTE FUNCTION fn_ca_alert_resolution_reaches_the_incident()","function_acl":"{postgres=X/postgres,service_role=X/postgres}","function_owner":"postgres","function_config":["search_path=public"],"function_secdef":true,"function_definition_md5":"dbe622139f98faf98bca7bc30db0155c"}],"force_rls":false,"constraints":[{"name":"financial_alerts_pkey","type":"p","validated":true,"definition":"PRIMARY KEY (id)"},{"name":"financial_alerts_resolved_by_fkey","type":"f","validated":true,"definition":"FOREIGN KEY (resolved_by) REFERENCES auth.users(id)"},{"name":"financial_alerts_severity_check","type":"c","validated":true,"definition":"CHECK (severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text]))"}],"postgres_trigger_privilege":true},{"acl":"{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}","rls":true,"kind":"r","name":"operational_alert_events","owner":"postgres","columns":[{"name":"id","type":"bigint","default":null,"identity":"a","not_null":true,"generated":""},{"name":"source","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"event_key","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"alertname","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"status","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"severity","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"payload","type":"jsonb","default":null,"identity":"","not_null":true,"generated":""},{"name":"received_at","type":"timestamp with time zone","default":"clock_timestamp()","identity":"","not_null":true,"generated":""},{"name":"last_received_at","type":"timestamp with time zone","default":"clock_timestamp()","identity":"","not_null":true,"generated":""},{"name":"delivery_count","type":"bigint","default":"1","identity":"","not_null":true,"generated":""},{"name":"investigation_status","type":"text","default":"'new'::text","identity":"","not_null":true,"generated":""},{"name":"investigation","type":"jsonb","default":"'{}'::jsonb","identity":"","not_null":true,"generated":""}],"indexes":["CREATE INDEX operational_alert_pending_idx ON public.operational_alert_events USING btree (investigation_status, id)","CREATE UNIQUE INDEX operational_alert_events_pkey ON public.operational_alert_events USING btree (id)","CREATE UNIQUE INDEX operational_alert_events_source_event_key_key ON public.operational_alert_events USING btree (source, event_key)"],"policies":null,"triggers":null,"force_rls":false,"constraints":[{"name":"operational_alert_events_alertname_check","type":"c","validated":true,"definition":"CHECK (length(alertname) >= 1 AND length(alertname) <= 240)"},{"name":"operational_alert_events_event_key_check","type":"c","validated":true,"definition":"CHECK (length(event_key) >= 1 AND length(event_key) <= 512)"},{"name":"operational_alert_events_investigation_status_check","type":"c","validated":true,"definition":"CHECK (investigation_status = ANY (ARRAY['new'::text, 'investigating'::text, 'blocked'::text, 'verified_fixed'::text, 'historical'::text, 'test'::text]))"},{"name":"operational_alert_events_payload_check","type":"c","validated":true,"definition":"CHECK (jsonb_typeof(payload) = 'object'::text AND octet_length(payload::text) <= 262144)"},{"name":"operational_alert_events_pkey","type":"p","validated":true,"definition":"PRIMARY KEY (id)"},{"name":"operational_alert_events_severity_check","type":"c","validated":true,"definition":"CHECK (length(severity) >= 1 AND length(severity) <= 40)"},{"name":"operational_alert_events_source_check","type":"c","validated":true,"definition":"CHECK (length(source) >= 1 AND length(source) <= 120)"},{"name":"operational_alert_events_source_event_key_key","type":"u","validated":true,"definition":"UNIQUE (source, event_key)"},{"name":"operational_alert_events_status_check","type":"c","validated":true,"definition":"CHECK (status = ANY (ARRAY['firing'::text, 'resolved'::text, 'info'::text]))"}],"postgres_trigger_privilege":true}]}$authority$::jsonb;
BEGIN
WITH relations AS (SELECT c.oid,c.relname,n.nspname,c.relowner,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN('financial_alerts','ca_drift_incidents','engine_alerts','engine_alert_delivery_receipts','operational_alert_events'))
SELECT jsonb_build_object(
'functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',r.rolname,'secdef',p.prosecdef,'config',p.proconfig,'acl',p.proacl::text,'definition_md5',md5(pg_get_functiondef(p.oid))) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='public' AND p.proname IN('fn_record_engine_alerts','fn_record_operational_alert')),
'relations',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',c.relacl::text,'postgres_trigger_privilege',has_table_privilege('postgres',c.oid,'TRIGGER'),
'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(ad.adbin,ad.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'type',k.contype,'validated',k.convalidated,'definition',pg_get_constraintdef(k.oid,true)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
'indexes',(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid),
'policies',(SELECT jsonb_agg(jsonb_build_object('name',pol.polname,'command',pol.polcmd,'roles',(SELECT jsonb_agg(CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END ORDER BY role_oid) FROM unnest(pol.polroles) role_oid),'permissive',pol.polpermissive,'using',pg_get_expr(pol.polqual,pol.polrelid),'check',pg_get_expr(pol.polwithcheck,pol.polrelid)) ORDER BY pol.polname) FROM pg_policy pol WHERE pol.polrelid=c.oid),
'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid,true),'function',p.oid::regprocedure::text,'function_owner',pg_get_userbyid(p.proowner),'function_acl',p.proacl::text,'function_secdef',p.prosecdef,'function_config',p.proconfig,'function_definition_md5',md5(pg_get_functiondef(p.oid))) ORDER BY t.tgname) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND NOT (p_post AND t.tgname='a00_operational_source_intake' AND c.relname IN ('engine_alerts','financial_alerts','ca_drift_incidents') AND t.tgfoid=to_regprocedure('public.fn_capture_operational_source_event()') AND t.tgenabled='O' AND t.tgtype=21 AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr=''::int2vector AND t.tgargs=''::bytea AND t.tgconstraint=0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL))) ORDER BY c.relname) FROM relations c)) INTO actual;
 expected:=jsonb_set(expected,'{functions,0,definition_md5}',to_jsonb(p_engine_md5));
 IF actual IS DISTINCT FROM expected THEN
   RAISE EXCEPTION 'direct operational source: current catalog authority differs';
 END IF;
END;
$guard$;
SELECT pg_temp.assert_direct_source_authority('2baee523d4b95afa879c230f4a5ff4f0',false);
DO $admission$
BEGIN
 IF current_user<>'postgres' OR to_regnamespace('operational_source_intake') IS NOT NULL
   OR to_regprocedure('public.fn_capture_operational_source_event()') IS NOT NULL
   OR to_regprocedure('public.fn_retry_operational_source_snapshot(uuid)') IS NOT NULL
   OR to_regprocedure('public.fn_read_operational_source_snapshot(bigint)') IS NOT NULL
 THEN RAISE EXCEPTION 'direct operational source: owner or first-install precondition differs'; END IF;
END $admission$;
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
  v_existing_row public.engine_alerts%rowtype;
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
        -- An old producer receipt alone is not an inbox acknowledgement.
        select * into strict v_existing_row from public.engine_alerts
          where id = v_existing.engine_alert_id for update;
        perform operational_source_intake.record_engine(v_existing_row,'replay');
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

SELECT pg_temp.assert_direct_source_authority('3b97b07170b81947137ee2adfc268717',true);
-- Exact new implementation and access check; no receipt is inferred from it.
DO $postimage$
DECLARE q record; p record;
BEGIN
 FOR q IN SELECT * FROM (VALUES
('operational_source_intake.immutable_snapshot()','68bdf7a5db54e55366f6c0fa8caf189b',false,'v','{postgres=X/postgres}',ARRAY['search_path=pg_catalog']),
('operational_source_intake.mapping(text,jsonb)','7cb4fc0324f276abdff8a04f2ba1307b',false,'i','{postgres=X/postgres}',ARRAY['search_path=pg_catalog']),
('operational_source_intake.reference(uuid)','358425f179677335a2ead4850951a958',false,'s','{postgres=X/postgres}',ARRAY['search_path=pg_catalog']),
('operational_source_intake.receipt_row(public.operational_alert_events,text)','844a92c85435dbef6120882773a2fd6e',false,'s','{postgres=X/postgres}',ARRAY['search_path=pg_catalog']),
('operational_source_intake.record_strict(text,jsonb,text,uuid)','021e82b3627b9655fc75ff37cc249188',false,'v','{postgres=X/postgres}',ARRAY['search_path=pg_catalog']),
('operational_source_intake.try_delivery(uuid)','07dc4112b098fbaa4ec6e530105d166a',false,'v','{postgres=X/postgres}',ARRAY['search_path=pg_catalog']),
('operational_source_intake.preserve(text,jsonb,text)','bbda8a1bddee3360d4d2c0eb65322472',false,'v','{postgres=X/postgres}',ARRAY['search_path=pg_catalog']),
('operational_source_intake.record_engine(public.engine_alerts,text)','1efd93fe723c91d6bdbf35fbafa0ef6c',false,'v','{postgres=X/postgres}',ARRAY['search_path=pg_catalog','TimeZone=UTC']),
('public.fn_capture_operational_source_event()','00a58b2d14702698dfd333d90458e7b7',true,'v','{postgres=X/postgres}',ARRAY['search_path=pg_catalog','TimeZone=UTC']),
('public.fn_retry_operational_source_snapshot(uuid)','129f0239ed41e51c0da6f6eb3a917d99',true,'v','{postgres=X/postgres,service_role=X/postgres}',ARRAY['search_path=pg_catalog']),
('public.fn_read_operational_source_snapshot(bigint)','8d7b36f717a2ec5851145838e2c6427f',true,'s','{postgres=X/postgres,service_role=X/postgres}',ARRAY['search_path=pg_catalog'])
 ) v(signature,body_md5,secdef,volatility,acl,config) LOOP
 SELECT md5(prosrc) body_md5,pg_get_userbyid(proowner) owner,prosecdef secdef,
   provolatile::text volatility,proacl::text acl,proconfig config INTO p
 FROM pg_proc WHERE oid=to_regprocedure(q.signature);
 IF NOT FOUND OR p.body_md5 IS DISTINCT FROM q.body_md5 OR p.owner<>'postgres'
   OR p.secdef IS DISTINCT FROM q.secdef OR p.volatility IS DISTINCT FROM q.volatility
   OR p.acl IS DISTINCT FROM q.acl OR p.config IS DISTINCT FROM q.config
 THEN RAISE EXCEPTION 'direct operational source: postimage function authority differs: %',q.signature; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_class WHERE relnamespace='operational_source_intake'::regnamespace
    AND relname IN ('snapshots','deliveries') AND relkind='r' AND relrowsecurity AND NOT relforcerowsecurity
    AND pg_get_userbyid(relowner)='postgres' AND relacl::text='{postgres=arwdDxtm/postgres,service_role=r/postgres}')<>2
   OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid IN ('operational_source_intake.snapshots'::regclass,'operational_source_intake.deliveries'::regclass))
   OR (SELECT count(*) FROM pg_trigger WHERE tgname='a00_operational_source_intake'
     AND tgrelid IN ('public.engine_alerts'::regclass,'public.financial_alerts'::regclass,'public.ca_drift_incidents'::regclass)
     AND tgenabled='O' AND tgtype=21 AND NOT tgdeferrable AND NOT tginitdeferred AND tgqual IS NULL
     AND tgfoid='public.fn_capture_operational_source_event()'::regprocedure)<>3
 THEN RAISE EXCEPTION 'direct operational source: postimage table/trigger authority differs'; END IF;
END $postimage$;
COMMIT;
