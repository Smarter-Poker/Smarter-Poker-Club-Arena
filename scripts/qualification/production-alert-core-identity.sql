-- SOURCE-ONLY / UNRUN. Native PostgreSQL qualification source, not admission.
-- Protected owner only: pinned psql -X, ON_ERROR_STOP, disposable isolated DB,
-- exact admitted execution UUID in qualification.execution_uuid, loopback/Unix
-- connection, no production credentials/network or live data. DB name must be
-- qual_owner_notify_<execution UUID without hyphens>. Required public schema,
-- functions, roles and guard baseline are the captured preimage; no migrations
-- or dependencies may be acquired by this script. All fixture mutations roll
-- back, including the migration. A later production migration is separate.
-- This executes the REAL bridge on a temporary trigger table. Only the incident
-- raiser is replaced by a declared argument recorder inside the fixture, after
-- snapshotting its exact definition and restoring it before migration guards.
-- It proves bridge/key/argument semantics, NOT real incident delivery, financial
-- timeout recovery, concurrent raiser execution, or production installation.
-- Installed downstream scope/retired-source decisions and the cap at 25 open
-- incidents remain untouched. Cap overflow uses its storm row/event containing
-- capped_dedupe_key; recorder rows are NOT proof of a distinct persisted incident.
\set ON_ERROR_STOP on
SELECT set_config('qualification.execution_uuid', :'execution_uuid', false);
DO $admission$
DECLARE v_id text := current_setting('qualification.execution_uuid', true);
BEGIN
  IF v_id IS NULL OR v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR current_database() <> 'qual_owner_notify_' || replace(v_id, '-', '')
     OR (inet_server_addr() IS NOT NULL AND inet_server_addr() NOT IN ('127.0.0.1'::inet, '::1'::inet))
     OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Requires the protected owner''s disposable native qualification allocation';
  END IF;
END;
$admission$;
BEGIN;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.financial_alerts LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.ca_drift_incidents LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.ca_incident_events LIMIT 1) THEN
    RAISE EXCEPTION 'Qualification requires empty financial/incident/history stores, not historical or production data';
  END IF;
END $$;
CREATE FUNCTION pg_temp.assert_true(v boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'qualification assertion: %', label; END IF; END $$;
CREATE TEMP TABLE qualification_original_functions AS
  SELECT oid, pg_get_functiondef(oid) AS definition FROM pg_proc
  WHERE oid IN ('public.fn_ca_financial_alert_to_incident()'::regprocedure,
    'public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure);
SELECT pg_temp.assert_true((SELECT md5(definition) = '3771aeef9008e35c6af3d03f220ebb3b'
  FROM qualification_original_functions WHERE oid = 'public.fn_ca_financial_alert_to_incident()'::regprocedure), 'exact installed preimage');

CREATE TEMP TABLE qualification_inputs (
  label text PRIMARY KEY, id uuid NOT NULL, source text NOT NULL, message text NOT NULL,
  severity text NOT NULL DEFAULT 'critical', context jsonb, category text NOT NULL);
INSERT INTO qualification_inputs(label,id,source,message,context,category) VALUES
 ('original_37375','3d335c16-aba5-4115-bddd-94d40a0fdf74','postHandTasks.leave_pending_failed',
  'Post-hand step leave_pending threw for hand #10757147 after 2 attempts; later steps continued',
  '{"error":"[postHandTasks.step_failed.leave_pending] Error: supabase_timeout","channel":"server_rpc","attempts":2,"table_id":"3906af70-b709-4471-ac6c-87b7df944e09","hand_number":10757147,"retry_budget":2}', 'original'),
 ('original_37377','d0c1e9ad-0154-437a-835b-c1e60ff035fa','postHandTasks.leave_pending_failed',
  'Post-hand step leave_pending threw for hand #10757202 after 2 attempts; later steps continued',
  '{"error":"[postHandTasks.step_failed.leave_pending] Error: supabase_timeout","channel":"server_rpc","attempts":2,"table_id":"71d90586-8b99-4f88-8a88-4920447801b2","hand_number":10757202,"retry_budget":2}', 'original'),
 ('original_37389','bf51bc70-32bd-4089-af1a-dc6edb436f00','postHandTasks.leave_pending_failed',
  'Post-hand step leave_pending threw for hand #10757153 after 2 attempts; later steps continued',
  '{"error":"[postHandTasks.step_failed.leave_pending] Error: supabase_timeout","channel":"server_rpc","attempts":2,"table_id":"09ee59dc-8129-42a4-ab33-c87bbf40ec5c","hand_number":10757153,"retry_budget":2}', 'original');

INSERT INTO qualification_inputs(label,id,source,message,context,category)
SELECT v.label, ('20000000-0000-4000-8000-' || lpad(v.n::text,12,'0'))::uuid,
  v.source, v.message, v.context, CASE WHEN v.label='nonmoney_flag' THEN 'severity' ELSE 'control' END
FROM (VALUES
 (1,'other_post_hand','postHandTasks.rake_failed','Qualification rake failed','{"table_id":"3906af70-b709-4471-ac6c-87b7df944e09","error":"fixture"}'::jsonb),
 (2,'other_invalid_table','postHandTasks.rake_failed','Qualification rake failed','{"table_id":"invalid","error":"fixture"}'::jsonb),
 (3,'near_name','postHandTasks.leave_pending_failed_extra','Qualification leave step failed','{"table_id":"3906af70-b709-4471-ac6c-87b7df944e09","hand_number":10}'::jsonb),
 (4,'tournament','Tournament.atomic_finish_refused','Qualification tournament refusal','{"tournament_id":"10000000-0000-4000-8000-000000000004","error":"fixture"}'::jsonb),
 (5,'prize','Tournament.prize_credit_failed','Qualification prize failure','{"tournament_id":"10000000-0000-4000-8000-000000000005"}'::jsonb),
 (6,'generic','qualification.generic','Qualification generic failure','{}'::jsonb),
 (7,'conservation','qualification.conservation','Qualification conservation failure','{}'::jsonb),
 (8,'server_nonmoney','ServerTableEngine.fixture','Qualification server failure','{}'::jsonb),
 (9,'semantic_refusal','ServerTableEngine.authoritative_hand_semantic_refusal','Qualification refusal','{}'::jsonb),
 (10,'post_commit','ServerTableEngine.post_commit_obligations_pending','Qualification pending','{}'::jsonb),
 (11,'mirror','drift_incident:qualification','Qualification mirror','{}'::jsonb),
 (12,'nonmoney_flag','postHandTasks.leave_pending_failed','Qualification no chips','{"moves_chips":false}'::jsonb)
) AS v(n,label,source,message,context);
INSERT INTO qualification_inputs SELECT 'warning', '20000000-0000-4000-8000-000000000013',
  source,message,'warning',context,'control' FROM qualification_inputs WHERE label='original_37375';

CREATE TEMP TABLE qualification_receipts (
  phase text, alert_id uuid, dedupe_key text, source text, classification text,
  severity text, discrepancy numeric, table_id uuid, tournament_id uuid, metadata jsonb);
CREATE TEMP TABLE qualification_trigger_input (id uuid,source text,message text,severity text,context jsonb);
CREATE TRIGGER qualification_actual_bridge AFTER INSERT ON qualification_trigger_input
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_financial_alert_to_incident();
CREATE FUNCTION pg_temp.install_argument_recorder() RETURNS void LANGUAGE plpgsql AS $install$
DECLARE v_oid oid := 'public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure;
  v_definition text; v_body text;
  v_recorder text := $recorder$
BEGIN
  INSERT INTO pg_temp.qualification_receipts VALUES (
    current_setting('qualification.phase'), (p_metadata->>'alert_id')::uuid,
    p_dedupe_key,p_source,p_classification,p_severity,p_discrepancy,p_table_id,p_tournament_id,p_metadata);
  RETURN (p_metadata->>'alert_id')::uuid;
END;
$recorder$;
BEGIN
  SELECT pg_get_functiondef(v_oid), prosrc INTO v_definition,v_body FROM pg_proc WHERE oid=v_oid;
  IF array_length(string_to_array(v_definition,v_body),1) <> 2 THEN RAISE EXCEPTION 'Ambiguous fixture raiser extraction'; END IF;
  EXECUTE replace(v_definition,v_body,v_recorder);
END $install$;
SELECT pg_temp.install_argument_recorder();
SET LOCAL qualification.phase = 'before';
INSERT INTO qualification_trigger_input SELECT id,source,message,severity,context FROM qualification_inputs;
SELECT pg_temp.assert_true((SELECT count(*)=3 AND count(DISTINCT dedupe_key)=1
  AND min(dedupe_key)='fa:postHandTasks.leave_pending_failed:02eb350684950d16c47506bd45a92d57'
  FROM qualification_receipts r JOIN qualification_inputs i ON i.id=r.alert_id WHERE i.category='original'), 'actual preimage reproduces all three received key collisions');
DO $$ DECLARE v_definition text; BEGIN
  SELECT definition INTO STRICT v_definition FROM qualification_original_functions WHERE oid =
    'public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure;
  EXECUTE v_definition;
END $$;

-- The actual migration is included, not a reimplemented CASE. No COMMIT exists
-- in that file, so this outer qualification transaction still owns rollback.
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
CREATE TEMP TABLE qualification_composed_raiser AS SELECT pg_get_functiondef('public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure) AS definition;
CREATE TEMP TABLE qualification_after_first AS SELECT
  pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure) AS definition,
  (SELECT to_jsonb(d) FROM public.ca_guard_defs d WHERE proname='fn_ca_financial_alert_to_incident') AS baseline,
  (SELECT jsonb_agg(to_jsonb(h) ORDER BY def_hash) FROM public.ca_guard_def_history h
    WHERE proname='fn_ca_financial_alert_to_incident') AS history;
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
SELECT pg_temp.assert_true((SELECT a.definition = pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure)
  AND a.baseline = (SELECT to_jsonb(d) FROM public.ca_guard_defs d WHERE proname='fn_ca_financial_alert_to_incident')
  AND a.history = (SELECT jsonb_agg(to_jsonb(h) ORDER BY def_hash) FROM public.ca_guard_def_history h WHERE proname='fn_ca_financial_alert_to_incident')
  FROM qualification_after_first a), 'exact replay changes neither function nor declaration/history timestamps');

-- Negative checks run the actual migration. Each deliberate private-fixture
-- drift and failed statement are rolled back to their savepoint before moving on.
SAVEPOINT authority_drift;
GRANT EXECUTE ON FUNCTION public.fn_ca_financial_alert_to_incident() TO authenticated;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT authority_drift;
SELECT pg_temp.assert_true(:'observed_state'='P0001','broadened bridge ACL refuses atomically');
SAVEPOINT config_drift;
ALTER FUNCTION public.fn_ca_financial_alert_to_incident() SET search_path TO public,pg_temp;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT config_drift;
SELECT pg_temp.assert_true(:'observed_state'='P0001','changed bridge config refuses atomically');
SAVEPOINT dependency_drift;
ALTER FUNCTION public.fn_ca_normalize_alert_text(text) SET search_path TO pg_catalog;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT dependency_drift;
SELECT pg_temp.assert_true(:'observed_state'='P0001','normalizer drift refuses atomically');
SAVEPOINT trigger_drift;
ALTER TABLE public.financial_alerts DISABLE TRIGGER trg_ca_financial_alert_incident;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT trigger_drift;
SELECT pg_temp.assert_true(:'observed_state'='P0001','disabled trigger refuses atomically');
SAVEPOINT body_drift;
DO $$ DECLARE v_oid oid := 'public.fn_ca_financial_alert_to_incident()'::regprocedure; v_def text; v_body text;
BEGIN SELECT pg_get_functiondef(v_oid),prosrc INTO v_def,v_body FROM pg_proc WHERE oid=v_oid;
  EXECUTE replace(v_def,v_body,v_body || E'\n-- deliberate qualification-only drift\n'); END $$;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT body_drift;
SELECT pg_temp.assert_true(:'observed_state'='P0001','unrelated full-body drift refuses atomically');
SAVEPOINT owner_drift;
-- PostgreSQL requires the proposed owner to hold schema CREATE before this
-- deliberate ownership corruption can reach the component guard. Confine that
-- prerequisite to this savepoint; the real API role retains no CREATE grant.
SELECT pg_temp.assert_true(NOT has_schema_privilege('authenticated','public','CREATE'),
  'owner-drift setup starts with unchanged API schema authority');
GRANT CREATE ON SCHEMA public TO authenticated;
ALTER FUNCTION public.fn_ca_financial_alert_to_incident() OWNER TO authenticated;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT owner_drift;
SELECT pg_temp.assert_true(NOT has_schema_privilege('authenticated','public','CREATE'),
  'owner-drift savepoint restores API schema authority');
SELECT pg_temp.assert_true(:'observed_state'='P0001','changed bridge owner refuses atomically');
SAVEPOINT security_drift;
ALTER FUNCTION public.fn_ca_financial_alert_to_incident() SECURITY INVOKER;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT security_drift;
SELECT pg_temp.assert_true(:'observed_state'='P0001','changed bridge security context refuses atomically');
SAVEPOINT raiser_drift;
ALTER FUNCTION public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb) SECURITY INVOKER;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT raiser_drift;
SELECT pg_temp.assert_true(:'observed_state'='P0001','raiser dependency drift refuses atomically');
SAVEPOINT scope_drift;
ALTER FUNCTION public.fn_ca_is_midway_scope(uuid,uuid,uuid,uuid,jsonb) SECURITY INVOKER;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT scope_drift;
SELECT pg_temp.assert_true(:'observed_state'='P0001','downstream scope dependency drift refuses atomically');
SAVEPOINT stable_key_drift;
ALTER FUNCTION public.fn_ca_stable_dedupe_key(text) SET search_path TO pg_catalog;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT stable_key_drift;
SELECT pg_temp.assert_true(:'observed_state'='P0001','downstream stable-key dependency drift refuses atomically');
SAVEPOINT resolution_drift;
GRANT EXECUTE ON FUNCTION public.fn_ca_alert_resolution_reaches_the_incident() TO anon;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT resolution_drift;
SELECT pg_temp.assert_true(:'observed_state'='P0001','resolution helper authority drift refuses atomically');
SAVEPOINT cert_drift;
REVOKE EXECUTE ON FUNCTION public.fn_ca_is_cert_account(uuid) FROM authenticated;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT cert_drift;
SELECT pg_temp.assert_true(:'observed_state'='P0001','certificate helper authority drift refuses atomically');
SAVEPOINT declaration_drift;
GRANT EXECUTE ON FUNCTION public.fn_ca_declare_guard_redefinition(text,text) TO authenticated;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT declaration_drift;
SELECT pg_temp.assert_true(:'observed_state'='P0001','declaration helper authority drift refuses atomically');
SAVEPOINT watchlist_drift;
ALTER FUNCTION public.fn_ca_guard_watchlist() SET search_path TO pg_catalog;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT watchlist_drift;
SELECT pg_temp.assert_true(:'observed_state'='P0001','watchlist dependency drift refuses atomically');
SAVEPOINT baseline_drift;
UPDATE public.ca_guard_defs SET def_hash='00000000000000000000000000000000'
  WHERE proname='fn_ca_financial_alert_to_incident';
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT baseline_drift;
SELECT pg_temp.assert_true(:'observed_state'='P0001','declared baseline drift refuses atomically');
SAVEPOINT primary_key_drift;
ALTER TABLE public.financial_alerts RENAME CONSTRAINT financial_alerts_pkey TO qualification_changed_pk;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT primary_key_drift;
SELECT pg_temp.assert_true(:'observed_state'='P0001','original-alert primary-key drift refuses atomically');
SAVEPOINT dedupe_index_drift;
ALTER INDEX public.ux_ca_drift_incidents_open_dedupe RENAME TO qualification_changed_dedupe;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT dedupe_index_drift;
SELECT pg_temp.assert_true(:'observed_state'='P0001','active-dedupe index drift refuses atomically');
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql

INSERT INTO qualification_inputs(label,id,source,message,severity,context,category)
SELECT v.label, ('30000000-0000-4000-8000-' || lpad(v.n::text,12,'0'))::uuid,
  b.source,b.message,b.severity,
  CASE WHEN v.label='sql_null' THEN NULL WHEN v.label='empty' THEN '{}'::jsonb
       WHEN v.label='missing_table' THEN b.context-'table_id'
       WHEN v.label='missing_hand' THEN b.context-'hand_number'
       ELSE jsonb_set(b.context,ARRAY[v.field],v.value) END,
  v.category
FROM qualification_inputs b CROSS JOIN (VALUES
 (1,'same_entity','hand_number','10757147'::jsonb,'valid'),
 (2,'same_table_other_hand','hand_number','10757148'::jsonb,'valid'),
 (3,'other_table_same_hand','table_id','"71d90586-8b99-4f88-8a88-4920447801b2"'::jsonb,'valid'),
 (4,'uppercase','table_id','"3906AF70-B709-4471-AC6C-87B7DF944E09"'::jsonb,'valid'),
 (5,'bigint_max','hand_number','9223372036854775807'::jsonb,'valid'),
 (6,'other_error','error','"[postHandTasks.step_failed.leave_pending] Error: different_root"'::jsonb,'valid'),
 (7,'sql_null',NULL,NULL::jsonb,'fallback'), (8,'empty',NULL,NULL::jsonb,'fallback'),
 (9,'missing_table',NULL,NULL::jsonb,'fallback'), (10,'missing_hand',NULL,NULL::jsonb,'fallback'),
 (11,'table_null','table_id','null'::jsonb,'fallback'),
 (12,'table_malformed','table_id','"invalid"'::jsonb,'fallback'),
 (13,'table_compact','table_id','"3906af70b7094471ac6c87b7df944e09"'::jsonb,'fallback'),
 (14,'table_braced','table_id','"{3906af70-b709-4471-ac6c-87b7df944e09}"'::jsonb,'fallback'),
 (15,'table_whitespace','table_id','" 3906af70-b709-4471-ac6c-87b7df944e09 "'::jsonb,'fallback'),
 (16,'table_boolean','table_id','true'::jsonb,'fallback'),
 (17,'table_object','table_id','{}'::jsonb,'fallback'),
 (18,'table_array','table_id','[]'::jsonb,'fallback'),
 (19,'hand_zero','hand_number','0'::jsonb,'fallback'),
 (20,'hand_negative','hand_number','-1'::jsonb,'fallback'),
 (21,'hand_fraction','hand_number','1.5'::jsonb,'fallback'),
 (22,'hand_out_of_range','hand_number','9223372036854775808'::jsonb,'fallback'),
 (23,'hand_huge','hand_number','9999999999999999999999999999999999999999'::jsonb,'fallback'),
 (24,'hand_whitespace','hand_number','" 10757147 "'::jsonb,'fallback'),
 (25,'hand_string','hand_number','"10757147"'::jsonb,'fallback'),
 (26,'hand_boolean','hand_number','true'::jsonb,'fallback'),
 (27,'hand_object','hand_number','{}'::jsonb,'fallback'),
 (28,'hand_array','hand_number','[]'::jsonb,'fallback'),
 (29,'hand_null','hand_number','null'::jsonb,'fallback'),
 (30,'hand_decimal_scale','hand_number','10757147.0'::jsonb,'fallback')
) AS v(n,label,field,value,category) WHERE b.label='original_37375';

SELECT pg_temp.install_argument_recorder();
SET LOCAL qualification.phase = 'after';
INSERT INTO qualification_trigger_input SELECT id,source,message,severity,context FROM qualification_inputs;
SELECT pg_temp.assert_true((SELECT count(*)=3 AND count(DISTINCT r.alert_id)=3 AND count(DISTINCT dedupe_key)=3
  AND bool_and((dedupe_key='fa:postHandTasks.leave_pending_failed:table:' || (i.context->>'table_id')
    || ':hand:' || (i.context->>'hand_number') || ':02eb350684950d16c47506bd45a92d57') IS TRUE)
  FROM qualification_receipts r JOIN qualification_inputs i ON i.id=r.alert_id
  WHERE r.phase='after' AND i.category='original'), 'all three exact originals remain individually keyed');
SELECT pg_temp.assert_true(NOT EXISTS (
  (SELECT r.alert_id,r.dedupe_key,r.source,r.classification,r.severity,r.discrepancy,r.table_id,r.tournament_id,r.metadata
    FROM qualification_receipts r JOIN qualification_inputs i ON i.id=r.alert_id WHERE r.phase='before' AND i.category='control'
   EXCEPT ALL
   SELECT r.alert_id,r.dedupe_key,r.source,r.classification,r.severity,r.discrepancy,r.table_id,r.tournament_id,r.metadata
    FROM qualification_receipts r JOIN qualification_inputs i ON i.id=r.alert_id WHERE r.phase='after' AND i.category='control')
  UNION ALL
  (SELECT r.alert_id,r.dedupe_key,r.source,r.classification,r.severity,r.discrepancy,r.table_id,r.tournament_id,r.metadata
    FROM qualification_receipts r JOIN qualification_inputs i ON i.id=r.alert_id WHERE r.phase='after' AND i.category='control'
   EXCEPT ALL
   SELECT r.alert_id,r.dedupe_key,r.source,r.classification,r.severity,r.discrepancy,r.table_id,r.tournament_id,r.metadata
    FROM qualification_receipts r JOIN qualification_inputs i ON i.id=r.alert_id WHERE r.phase='before' AND i.category='control')
), 'unchanged other sources, skips, severity, typed arguments and invalid UUID behavior');
SELECT pg_temp.assert_true((SELECT count(*)=14 AND count(DISTINCT r.alert_id)=7
  FROM qualification_receipts r JOIN qualification_inputs i ON i.id=r.alert_id
  WHERE i.category='control'), 'seven positive control sources actually reached the real bridge in both phases');
SELECT pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM qualification_receipts r JOIN qualification_inputs i ON i.id=r.alert_id
  WHERE i.label IN ('other_invalid_table','semantic_refusal','post_commit','mirror','warning')), 'five existing skip/failure behaviors remain unchanged');
SELECT pg_temp.assert_true((SELECT count(*)=24 AND count(DISTINCT r.alert_id)=24 AND count(DISTINCT r.dedupe_key)=24
  AND bool_and((r.dedupe_key = 'fa:postHandTasks.leave_pending_failed:alert:' || i.id::text || ':'
    || md5(public.fn_ca_normalize_alert_text(left(i.message,200)) || '|'
      || public.fn_ca_normalize_alert_text(left(COALESCE(i.context->>'error',''),200)))) IS TRUE)
  FROM qualification_receipts r JOIN qualification_inputs i ON i.id=r.alert_id
  WHERE r.phase='after' AND i.category='fallback'), 'every invalid/missing identity persists independently without cast loss');
SELECT pg_temp.assert_true((SELECT count(*)=33 AND count(DISTINCT r.alert_id)=33
  AND bool_and((r.metadata = (COALESCE(i.context,'{}'::jsonb)||jsonb_build_object('alert_id',i.id))) IS TRUE)
  AND bool_and((r.severity='critical') IS TRUE)
  FROM qualification_receipts r JOIN qualification_inputs i ON i.id=r.alert_id
  WHERE r.phase='after' AND i.category IN ('original','valid','fallback')), 'all original context survives and severity is unchanged');
SELECT pg_temp.assert_true((SELECT count(*)=2 AND count(DISTINCT r.phase)=2 AND bool_and((r.severity='info') IS TRUE)
  FROM qualification_receipts r JOIN qualification_inputs i ON i.id=r.alert_id
  WHERE i.label='nonmoney_flag'), 'explicit moves_chips false keeps the existing info decision before and after');
SELECT pg_temp.assert_true((SELECT count(*)=9 AND count(DISTINCT r.alert_id)=9
  AND bool_and((r.dedupe_key = 'fa:postHandTasks.leave_pending_failed:table:'
    || (i.context->>'table_id')::uuid::text || ':hand:' || (i.context->>'hand_number') || ':'
    || md5(public.fn_ca_normalize_alert_text(left(i.message,200)) || '|'
      || public.fn_ca_normalize_alert_text(left(COALESCE(i.context->>'error',''),200)))) IS TRUE)
  AND bool_and((r.table_id = (i.context->>'table_id')::uuid) IS TRUE)
  FROM qualification_receipts r JOIN qualification_inputs i ON i.id=r.alert_id
  WHERE r.phase='after' AND i.category IN ('original','valid')), 'all valid originals/variants have their exact canonical table, exact hand and normalized shape');
SELECT pg_temp.assert_true((SELECT count(*)=3 AND count(DISTINCT r.dedupe_key)=1
  FROM qualification_receipts r JOIN qualification_inputs i ON i.id=r.alert_id
  WHERE r.phase='after' AND i.label IN ('original_37375','same_entity','uppercase')), 'same entity repeat and canonical uppercase UUID dedupe together');
SELECT pg_temp.assert_true((SELECT count(*)=4 AND count(DISTINCT r.dedupe_key)=4
  FROM qualification_receipts r JOIN qualification_inputs i ON i.id=r.alert_id
  WHERE r.phase='after' AND i.label IN ('original_37375','same_table_other_hand','other_table_same_hand','other_error')), 'table, hand and error changes each retain a distinct incident');
SELECT pg_temp.assert_true((SELECT split_part(split_part(r.dedupe_key, ':hand:',2), ':',1)='9223372036854775807'
  FROM qualification_receipts r JOIN qualification_inputs i ON i.id=r.alert_id
  WHERE r.phase='after' AND i.label='bigint_max'), 'maximum bigint is retained exactly, without float coercion');
SELECT pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM qualification_receipts r JOIN qualification_inputs i ON i.id=r.alert_id
  WHERE r.phase='after' AND i.label IN ('sql_null','empty','missing_table','table_null','table_malformed','table_compact','table_braced','table_whitespace','table_boolean','table_object','table_array')
    AND r.table_id IS NOT NULL), 'invalid table identity has a NULL typed argument, preserved raw context');
SELECT pg_temp.assert_true((SELECT count(*)=33 AND bool_and((public.fn_ca_stable_dedupe_key(r.dedupe_key)=r.dedupe_key) IS TRUE)
  FROM qualification_receipts r JOIN qualification_inputs i ON i.id=r.alert_id
  WHERE r.phase='after' AND i.category IN ('original','valid','fallback')), 'actual stable-key helper does not fold the hash-terminated identity keys');
SELECT pg_temp.assert_true((SELECT count(*)=11 AND bool_and((public.fn_ca_is_midway_scope(
    NULL,NULL,NULL,NULL,COALESCE(i.context,'{}'::jsonb)||jsonb_build_object('alert_id',i.id))) IS TRUE)
  FROM qualification_inputs i WHERE i.label IN ('sql_null','empty','missing_table','table_null','table_malformed','table_compact','table_braced','table_whitespace','table_boolean','table_object','table_array')),
  'actual scope helper neither casts invalid raw table metadata nor changes its existing global-scope decision');

-- Restore the exact dependency and prove final replay once more before rollback.
DO $$ DECLARE v_definition text; BEGIN
  SELECT definition INTO STRICT v_definition FROM qualification_composed_raiser;
  EXECUTE v_definition;
END $$;
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
SELECT pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM public.financial_alerts LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM public.ca_drift_incidents LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM public.ca_incident_events LIMIT 1), 'qualification never wrote real financial/incident/history rows');
SELECT 'NATIVE_ASSERTIONS_COMPLETED; executor rollback/cleanup receipt still required' AS scope;
ROLLBACK;
