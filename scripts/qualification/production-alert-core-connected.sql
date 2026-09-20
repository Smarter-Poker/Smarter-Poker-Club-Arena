-- SOURCE ONLY / UNRUN. Real trigger/raiser/mirror/notification/inbox SQL chain.
-- Requires the existing isolated authenticated owner-notification fixture,
-- its routing component installed, then core-catalog-supplement.sql.
-- No sender, API, Realtime, financial reconciliation or production proof.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='3s';
SET LOCAL timezone='UTC';
SET LOCAL search_path=public,pg_temp;
CREATE TEMP TABLE core_inputs AS SELECT :'execution_uuid'::uuid execution,
  '47965354-0e56-43ef-931c-ddaab82af765'::uuid owner_user,
  '10000000-0000-4000-8000-000000000001'::uuid table_id;
CREATE FUNCTION pg_temp.core_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'core qualification: %',label; END IF; END $$;
SELECT pg_temp.core_assert(session_user='postgres' AND current_user='postgres'
  AND current_database()='qual_owner_notify_'||replace(execution::text,'-','')
  AND current_setting('server_version_num')::integer BETWEEN 170000 AND 179999
  AND inet_server_addr() IS NULL,'exact isolated PG17 owner allocation') FROM core_inputs;
SELECT pg_temp.core_assert(NOT EXISTS(SELECT 1 FROM financial_alerts)
  AND NOT EXISTS(SELECT 1 FROM ca_drift_incidents)
  AND NOT EXISTS(SELECT 1 FROM ca_incident_events)
  AND NOT EXISTS(SELECT 1 FROM ca_incident_recipients),'empty financial/incident/recipient fixture');
SELECT pg_temp.core_assert(to_regclass('operational_notification_destinations') IS NOT NULL
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='notifications'::regclass
    AND tgname='zz_capture_owner_notification_destination' AND tgenabled='O'),
  'actual owner destination capture installed');
CREATE TEMP TABLE core_original_definitions AS SELECT p.proname,pg_get_functiondef(p.oid) definition
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN
  ('fn_ca_financial_alert_to_incident','fn_ca_raise_drift_incident','fn_ca_escalate_reconcile_criticals');
\ir ../ci/probes/production-alert-core/inputs/received-reconcile.sql
CREATE TEMP TABLE core_before AS SELECT
  (SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM notifications n) notifications,
  (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM operational_alert_events e) inbox,
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM push_outbox p) pushes;
INSERT INTO ca_incident_recipients(user_id,scope,active,senior)
  SELECT owner_user,'platform',true,true FROM core_inputs;
CREATE TEMP TABLE core_receipts(label text PRIMARY KEY, alert_id uuid NOT NULL);
CREATE FUNCTION pg_temp.core_emit(p_label text,p_hand jsonb,p_table jsonb)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  SELECT public.fn_raise_server_financial_alert('critical','postHandTasks.leave_pending_failed',
    'Post-hand step leave_pending threw for hand #17; later steps continued',
    jsonb_build_object('table_id',p_table,'hand_number',p_hand,'error','supabase_timeout',
      'club_id','fade0000-0000-0000-0000-000000000001','amount',12),
    'core-qualification:'||p_label,NULL) INTO v_id;
  PERFORM pg_temp.core_assert(v_id IS NOT NULL,'real server financial producer returned an identity');
  INSERT INTO core_receipts VALUES(p_label,v_id);
  RETURN v_id;
END $$;
-- The injected scope and nominal amount are fixture-only and identical before
-- and after. They exercise the real notify branch without moving any money.
SAVEPOINT core_anon_denial;
SET LOCAL ROLE anon;
\set ON_ERROR_STOP off
SELECT * FROM public.fn_ca_escalate_reconcile_criticals();
\set core_role_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO core_anon_denial;
SELECT pg_temp.core_assert(:'core_role_state'='42501','anon cannot execute real escalation');
SAVEPOINT core_authenticated_denial;
SET LOCAL ROLE authenticated;
\set ON_ERROR_STOP off
SELECT * FROM public.fn_ca_escalate_reconcile_criticals();
\set core_role_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO core_authenticated_denial;
SELECT pg_temp.core_assert(:'core_role_state'='42501','authenticated cannot execute real escalation');
SET LOCAL ROLE service_role;
SELECT considered AS core_service_considered,filed AS core_service_filed FROM public.fn_ca_escalate_reconcile_criticals() \gset
RESET ROLE;
SELECT pg_temp.core_assert(:'core_service_considered'='0' AND :'core_service_filed'='0','service role executes real empty escalation');
SAVEPOINT wording_behaviour;
INSERT INTO ca_drift_incidents(source,dedupe_key)
  SELECT 'core_storm','core_storm:'||n FROM generate_series(1,25)n;
SELECT public.fn_ca_raise_drift_incident('core_storm','ledger_imbalance','critical','core_storm:hand:first',0.11);
SELECT public.fn_ca_raise_drift_incident('core_storm','ledger_imbalance','critical','core_storm:hand:second',0.22);
SELECT pg_temp.core_assert((SELECT count(*)=1 AND bool_and(occurrences=2 AND discrepancy_amount=0
  AND suspected_cause LIKE '%Every occurrence is still in financial_alerts%') FROM ca_drift_incidents WHERE dedupe_key='storm:core_storm')
  AND (SELECT count(*)=2 AND count(DISTINCT e.detail->>'capped_dedupe_key')=2
    FROM ca_incident_events e JOIN ca_drift_incidents i ON e.incident_id=i.id
    WHERE i.dedupe_key='storm:core_storm' AND e.kind='recurred'),
  'actual original storm wording with preserved independent finding events');
INSERT INTO ledger_reconcile_log(id,entity_type,entity_id,ledger_balance,stored_balance,severity,
  metadata,notes,run_date,run_ts,created_at)
  SELECT id,entity_type,entity_id,ledger_balance,stored_balance,severity,metadata,notes,run_date,run_ts,now()
  FROM qualification_received_reconcile;
INSERT INTO ledger_reconcile_log(entity_type,entity_id,ledger_balance,stored_balance,severity,metadata)
  VALUES('club_treasury','fade0000-0000-0000-0000-000000000001',10,8,'critical','{}');
SELECT pg_temp.core_assert((SELECT considered=5 AND filed=5 FROM fn_ca_escalate_reconcile_criticals()),
  'actual escalator considers and files four received findings plus treasury control');
SELECT pg_temp.core_assert((SELECT count(*)=4 AND bool_and(i.suspected_cause='reconcile_ledger_nightly reported a critical drift for this rake_law: the stored balance and the journal disagree.')
  FROM ca_drift_incidents i JOIN qualification_received_reconcile r ON i.entity_id=r.entity_id
  WHERE i.entity_type='rake_law'), 'actual original rake evidence message');
SELECT pg_temp.core_assert((SELECT count(*)=1 AND bool_and(suspected_cause=
  'reconcile_ledger_nightly reported a critical drift for this club_treasury: the stored balance and the journal disagree.')
  FROM ca_drift_incidents WHERE entity_type='club_treasury'),'non-rake escalator wording stays exact');
ROLLBACK TO wording_behaviour;
SAVEPOINT original_collision;
SELECT pg_temp.core_emit('before1','17',to_jsonb(table_id)) FROM core_inputs;
SELECT pg_temp.core_emit('before2','18',to_jsonb(table_id)) FROM core_inputs;
SELECT pg_temp.core_assert((SELECT count(*)=2 FROM financial_alerts
  WHERE source='postHandTasks.leave_pending_failed') AND
  (SELECT count(*)=1 AND bool_and(occurrences=2) FROM ca_drift_incidents
  WHERE source='financial_alerts:postHandTasks.leave_pending_failed'),
  'real original source reproduces cross-hand incident collision');
ROLLBACK TO original_collision;
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
CREATE TEMP TABLE core_installed AS SELECT
  (SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,
    'definition',pg_get_functiondef(p.oid)) ORDER BY p.proname) FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND p.proname IN
    ('fn_ca_financial_alert_to_incident','fn_ca_raise_drift_incident','fn_ca_escalate_reconcile_criticals')) definitions,
  (SELECT jsonb_agg(to_jsonb(g) ORDER BY proname) FROM ca_guard_defs g) guards,
  (SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM ca_guard_def_history h) history;
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
SELECT pg_temp.core_assert(i.definitions=(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,
  'definition',pg_get_functiondef(p.oid)) ORDER BY p.proname) FROM pg_proc p
  WHERE p.pronamespace='public'::regnamespace AND p.proname IN
  ('fn_ca_financial_alert_to_incident','fn_ca_raise_drift_incident','fn_ca_escalate_reconcile_criticals'))
  AND i.guards=(SELECT jsonb_agg(to_jsonb(g) ORDER BY proname) FROM ca_guard_defs g)
  AND i.history=(SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM ca_guard_def_history h),
  'aggregate replay preserves all three definitions and exact guard history') FROM core_installed i;
SAVEPOINT wording_behaviour;
INSERT INTO ca_drift_incidents(source,dedupe_key)
  SELECT 'core_storm','core_storm:'||n FROM generate_series(1,25)n;
SELECT public.fn_ca_raise_drift_incident('core_storm','ledger_imbalance','critical','core_storm:hand:first',0.11);
SELECT public.fn_ca_raise_drift_incident('core_storm','ledger_imbalance','critical','core_storm:hand:second',0.22);
SELECT pg_temp.core_assert((SELECT count(*)=1 AND bool_and(occurrences=2 AND discrepancy_amount=0
  AND suspected_cause LIKE '%See this incident%') FROM ca_drift_incidents WHERE dedupe_key='storm:core_storm')
  AND (SELECT count(*)=2 AND count(DISTINCT e.detail->>'capped_dedupe_key')=2
    FROM ca_incident_events e JOIN ca_drift_incidents i ON e.incident_id=i.id
    WHERE i.dedupe_key='storm:core_storm' AND e.kind='recurred'),
  'actual final storm wording with preserved independent finding events');
INSERT INTO ledger_reconcile_log(id,entity_type,entity_id,ledger_balance,stored_balance,severity,
  metadata,notes,run_date,run_ts,created_at)
  SELECT id,entity_type,entity_id,ledger_balance,stored_balance,severity,metadata,notes,run_date,run_ts,now()
  FROM qualification_received_reconcile;
INSERT INTO ledger_reconcile_log(entity_type,entity_id,ledger_balance,stored_balance,severity,metadata)
  VALUES('club_treasury','fade0000-0000-0000-0000-000000000001',10,8,'critical','{}');
SELECT pg_temp.core_assert((SELECT considered=5 AND filed=5 FROM fn_ca_escalate_reconcile_criticals()),
  'actual escalator considers and files four received findings plus treasury control');
SELECT pg_temp.core_assert((SELECT count(*)=4 AND bool_and(i.suspected_cause='The rake-law monitor reported a critical finding about recorded rake and the rake specification. This finding alone does not establish a stored-balance/journal disagreement.')
  FROM ca_drift_incidents i JOIN qualification_received_reconcile r ON i.entity_id=r.entity_id
  WHERE i.entity_type='rake_law'), 'actual final rake evidence message');
SELECT pg_temp.core_assert((SELECT count(*)=1 AND bool_and(suspected_cause=
  'reconcile_ledger_nightly reported a critical drift for this club_treasury: the stored balance and the journal disagree.')
  FROM ca_drift_incidents WHERE entity_type='club_treasury'),'non-rake escalator wording stays exact');
ROLLBACK TO wording_behaviour;
SAVEPOINT mixed_bridge;
DO $$ BEGIN EXECUTE (SELECT definition FROM core_original_definitions WHERE proname='fn_ca_financial_alert_to_incident'); END $$;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set core_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO mixed_bridge;
SELECT pg_temp.core_assert(:'core_state'='P0001','mixed_bridge refuses atomically');
SAVEPOINT mixed_raiser;
DO $$ BEGIN EXECUTE (SELECT definition FROM core_original_definitions WHERE proname='fn_ca_raise_drift_incident'); END $$;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set core_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO mixed_raiser;
SELECT pg_temp.core_assert(:'core_state'='P0001','mixed_raiser refuses atomically');
SAVEPOINT mixed_escalator;
DO $$ BEGIN EXECUTE (SELECT definition FROM core_original_definitions WHERE proname='fn_ca_escalate_reconcile_criticals'); END $$;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set core_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO mixed_escalator;
SELECT pg_temp.core_assert(:'core_state'='P0001','mixed_escalator refuses atomically');
SAVEPOINT escalator_acl;
GRANT EXECUTE ON FUNCTION fn_ca_escalate_reconcile_criticals(interval) TO authenticated;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set core_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO escalator_acl;
SELECT pg_temp.core_assert(:'core_state'='P0001','escalator_acl refuses atomically');
SAVEPOINT escalator_config;
ALTER FUNCTION fn_ca_escalate_reconcile_criticals(interval) SET search_path=public,pg_temp;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set core_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO escalator_config;
SELECT pg_temp.core_assert(:'core_state'='P0001','escalator_config refuses atomically');
SAVEPOINT reconcile_trigger;
ALTER TABLE ledger_reconcile_log DISABLE TRIGGER trg_ca_reconcile_log_incident;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set core_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO reconcile_trigger;
SELECT pg_temp.core_assert(:'core_state'='P0001','reconcile_trigger refuses atomically');
SAVEPOINT raiser_declaration;
UPDATE ca_guard_defs SET declared_ref='unrelated' WHERE proname='fn_ca_raise_drift_incident';
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set core_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO raiser_declaration;
SELECT pg_temp.core_assert(:'core_state'='P0001','raiser_declaration refuses atomically');
SAVEPOINT notify_acl;
GRANT EXECUTE ON FUNCTION fn_ca_incident_notify(uuid,text,text,boolean) TO authenticated;
\set ON_ERROR_STOP off
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
\set core_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO notify_acl;
SELECT pg_temp.core_assert(:'core_state'='P0001','notify_acl refuses atomically');
SELECT pg_temp.core_emit('after1','17',to_jsonb(table_id)) FROM core_inputs;
SELECT pg_temp.core_emit('after2','18',to_jsonb(table_id)) FROM core_inputs;
SELECT pg_temp.core_assert((SELECT count(*)=2 AND count(DISTINCT dedupe_key)=2
  AND bool_and(occurrences=1 AND table_id=(SELECT table_id FROM core_inputs))
  FROM ca_drift_incidents WHERE source='financial_alerts:postHandTasks.leave_pending_failed'),
  'real final bridge creates distinct persisted exact-hand incidents');
SELECT pg_temp.core_assert((SELECT count(*)=2 FROM ca_drift_incidents i JOIN core_receipts r
  ON i.metadata->>'alert_id'=r.alert_id::text WHERE r.label IN('after1','after2')),
  'both originals retain their exact mirror identity');
SELECT pg_temp.core_assert((SELECT count(*)=2 FROM notifications n JOIN ca_drift_incidents i
  ON n.data->>'incident_id'=i.id::text JOIN core_receipts r ON i.metadata->>'alert_id'=r.alert_id::text
  JOIN operational_notification_destinations d ON d.notification_id=n.id
  JOIN operational_alert_events e ON e.id=d.inbox_event_id
  WHERE r.label IN('after1','after2') AND n.user_id=(SELECT owner_user FROM core_inputs)
  AND e.source='owner-operational-notifications' AND e.event_key=n.id::text
  AND e.payload->'original_notification'->'data'->>'incident_id'=i.id::text
  AND d.last_error IS NULL),'actual notification capture has exact durable inbox receipts');
SELECT pg_temp.core_assert((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM push_outbox p)
  IS NOT DISTINCT FROM (SELECT pushes FROM core_before),
  'operational incident notifications create no personal push work');
CREATE TEMP TABLE core_notification_ids AS SELECT n.id FROM notifications n
  JOIN ca_drift_incidents i ON n.data->>'incident_id'=i.id::text;
GRANT SELECT ON core_inputs,core_notification_ids TO authenticated;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',owner_user,'role','authenticated')::text,true),
  set_config('request.jwt.claim.sub',owner_user::text,true) FROM core_inputs;
SET LOCAL ROLE authenticated;
SELECT pg_temp.core_assert(NOT EXISTS(SELECT 1 FROM personal_notifications n
  JOIN core_notification_ids i ON i.id=n.id),'actual authenticated owner view excludes operational incidents');
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true),set_config('request.jwt.claim.sub','',true);
SELECT pg_temp.core_emit('same-hand','18',to_jsonb(table_id)) FROM core_inputs;
SELECT pg_temp.core_assert((SELECT count(*)=2 AND max(occurrences)=2 FROM ca_drift_incidents
  WHERE source='financial_alerts:postHandTasks.leave_pending_failed'),
  'same-hand recurrence remains one incident');
SELECT pg_temp.core_emit('malformed','"18"','"bad-table"');
SELECT pg_temp.core_assert((SELECT count(*)=1 AND bool_and(i.table_id IS NULL
  AND i.dedupe_key LIKE 'fa:postHandTasks.leave_pending_failed:alert:'||r.alert_id::text||':%'
  AND i.metadata->>'table_id'='bad-table' AND jsonb_typeof(i.metadata->'hand_number')='string')
  FROM ca_drift_incidents i JOIN core_receipts r ON i.metadata->>'alert_id'=r.alert_id::text
  WHERE r.label='malformed'),'malformed identity persists fallback with original raw evidence');
CREATE TEMP TABLE core_before_resolution AS SELECT count(*) n FROM notifications;
UPDATE financial_alerts f SET resolved=true,resolved_at=now(),
  resolution='Synthetic isolated fixture: exact alert mirror propagation, no financial disposition.'
  FROM core_receipts r WHERE r.label='after1' AND f.id=r.alert_id;
SELECT pg_temp.core_assert((SELECT count(*)=1 AND bool_and(i.status='resolved')
  FROM ca_drift_incidents i JOIN core_receipts r ON i.metadata->>'alert_id'=r.alert_id::text
  WHERE r.label='after1') AND (SELECT count(*)=2 FROM ca_drift_incidents WHERE status<>'resolved'),
  'real resolution mirror closes only its exact original');
SELECT pg_temp.core_assert((SELECT count(*) FROM notifications)=(SELECT n FROM core_before_resolution),
  'resolution creates no owner recovery notification');
SELECT pg_temp.core_assert(NOT EXISTS(SELECT 1 FROM ca_incident_file_failures)
  AND NOT EXISTS(SELECT 1 FROM ca_incident_events WHERE kind='notify_failed'),
  'connected path has no swallowed incident, mirror or notification failure');
-- Source rollback preserves all existing receipts and synthetic subject rows.
CREATE TEMP TABLE core_subjects AS SELECT
  (SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM financial_alerts f) financial,
  (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM ca_drift_incidents i) incidents,
  (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM ca_incident_events e) events,
  (SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM notifications n) notifications,
  (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM operational_alert_events e) inbox;
\ir ../../supabase/components/production-alert-identity-and-rake-wording.rollback.sql
\ir ../../supabase/components/production-alert-identity-and-rake-wording.rollback.sql
SELECT pg_temp.core_assert(s.financial=(SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM financial_alerts f)
  AND s.incidents=(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM ca_drift_incidents i)
  AND s.events=(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM ca_incident_events e)
  AND s.notifications=(SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM notifications n)
  AND s.inbox=(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM operational_alert_events e),
  'source rollback and rollback replay preserve all subject and delivery rows') FROM core_subjects s;
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
SELECT 'COMPOSED_CONNECTED_ASSERTIONS_COMPLETED; requires external rollback/terminal/cleanup proof';
ROLLBACK;
