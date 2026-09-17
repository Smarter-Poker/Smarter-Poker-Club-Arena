-- SOURCE ONLY / UNRUN. Same owned PG17 full-schema core fixture; no new database
-- framework, financial repair, synthetic payment or production execution.
-- Cash's existing severity policy suppresses incident/inbox delivery. The real
-- qualifying control must reach that same trigger/raiser/notification graph.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='3s';
SET LOCAL timezone='UTC';
SET LOCAL search_path=public,pg_temp;
SELECT set_config('cash_connected.execution_uuid',:'execution_uuid',true);
CREATE FUNCTION pg_temp.cash_connected_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'cash connected qualification: %',label; END IF; END $$;
SELECT pg_temp.cash_connected_assert(session_user='postgres' AND current_user='postgres'
 AND current_database()='qual_owner_notify_'||replace(:'execution_uuid'::uuid::text,'-','')
 AND current_setting('server_version_num')::integer BETWEEN 170000 AND 179999
 AND inet_server_addr() IS NULL AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user),
 'exact existing isolated non-superuser PG17 fixture');
SELECT pg_temp.cash_connected_assert(NOT EXISTS(SELECT 1 FROM hand_history)
 AND NOT EXISTS(SELECT 1 FROM financial_alerts) AND NOT EXISTS(SELECT 1 FROM ca_drift_incidents)
 AND NOT EXISTS(SELECT 1 FROM ca_incident_events) AND NOT EXISTS(SELECT 1 FROM ca_incident_recipients)
 AND NOT EXISTS(SELECT 1 FROM ca_incident_file_failures)
 AND to_regclass('ca_cash_pot_check_evidence') IS NULL,
 'empty authentic financial fixture and missing candidate store');
\ir ../ci/probes/production-alert-core/cash-checker-preimage.sql
\ir ../../supabase/components/production-alert-identity-and-rake-wording.sql
SELECT pg_temp.cash_connected_assert(
 md5(pg_get_functiondef('public.fn_cash_pot_conservation_check(integer)'::regprocedure))='484ca087624199de5a28678a2799ff75'
 AND md5(pg_get_functiondef('public.fn_raise_server_financial_alert(text,text,text,jsonb,text,text)'::regprocedure))='264d32bcba8f6430ea68b7ca9738fbc8'
 AND md5(pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure))='00a43ae03ab12cec9505e2bfed71d937'
 AND md5(pg_get_functiondef('public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure))='a6df5f2eef07aa3f606db79d93944590'
 AND md5(pg_get_functiondef('public.fn_ca_escalate_reconcile_criticals(interval)'::regprocedure))='85393514508e56d5e58bc4e5e0363e1c',
 'exact checker, six-argument producer and all three composed core functions');
SELECT pg_temp.cash_connected_assert(EXISTS(SELECT 1 FROM pg_trigger
 WHERE tgrelid='financial_alerts'::regclass AND tgname='trg_ca_financial_alert_incident'
 AND tgenabled='O' AND tgfoid='fn_ca_financial_alert_to_incident()'::regprocedure)
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='notifications'::regclass
 AND tgname='zz_capture_owner_notification_destination' AND tgenabled='O'),
 'real bridge and owner notification capture enabled');
CREATE FUNCTION pg_temp.cash_business_snapshot() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(
 'profiles',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM profiles x),
 'wallets',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM wallets x),
 'club_wallets',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM club_wallets x),
 'union_wallets',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM union_wallets x),
 'chip_ledger',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM chip_ledger x),
 'wallet_transactions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM wallet_transactions x),
 'diamond_wallets',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM diamond_wallets x),
 'diamond_transactions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM diamond_transactions x));
$$;
CREATE TEMP TABLE cash_before AS SELECT pg_temp.cash_business_snapshot() money,
 (SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM notifications n) notifications,
 (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM operational_alert_events e) inbox,
 (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM push_outbox p) pushes;
-- Null table ids and empty participants are valid source rows; every authentic
-- hand-history constraint/trigger remains enabled. No financial entity is invented.
INSERT INTO hand_history(id,table_id,hand_number,created_at,pot_size,rake_amount,bbj_amount,
 winners,players,actions,daily_mission_events)
 SELECT ('c4053800-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,NULL,g,now()-interval '1 hour',
 CASE WHEN g=1 THEN 600 WHEN g=22 THEN 10 ELSE 1 END,0,0,
 CASE WHEN g=22 THEN '[{"amount":9}]'::jsonb WHEN g=23 THEN '[{"amount":1}]'::jsonb ELSE '[]'::jsonb END,
 '[]'::jsonb,'[]'::jsonb,'[]'::jsonb FROM generate_series(1,23) g;
CREATE TEMP TABLE cash_subjects AS SELECT jsonb_agg(to_jsonb(h) ORDER BY id) hands FROM hand_history h;
CREATE TEMP TABLE cash_results(label text PRIMARY KEY,result jsonb NOT NULL);
INSERT INTO cash_results VALUES('before',public.fn_cash_pot_conservation_check(24));
SELECT pg_temp.cash_connected_assert((SELECT result=jsonb_build_object('ok',true,'since_hours',24,
 'hands_checked',23,'pot_not_distributed',1,'pot_not_distributed_chips',1,
 'no_winner_recorded',21,'no_winner_recorded_chips',620,'conditions_alerted',2)
 FROM cash_results WHERE label='before'), 'original financial arithmetic and result');
SELECT pg_temp.cash_connected_assert((SELECT count(*)=2 FROM financial_alerts
 WHERE source='fn_cash_pot_conservation_check')
 AND NOT EXISTS(SELECT 1 FROM ca_drift_incidents) AND NOT EXISTS(SELECT 1 FROM ca_incident_file_failures)
 AND (SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM notifications n) IS NOT DISTINCT FROM (SELECT notifications FROM cash_before)
 AND (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM operational_alert_events e) IS NOT DISTINCT FROM (SELECT inbox FROM cash_before),
 'original cash findings persist but lose complete evidence and intentionally create no incident/inbox');
CREATE TEMP TABLE cash_original_financial AS SELECT jsonb_agg(to_jsonb(f) ORDER BY id) rows FROM financial_alerts f;
\ir ../../supabase/components/cash-pot-check-evidence.sql
\ir ../../supabase/components/cash-pot-check-evidence.sql
INSERT INTO cash_results VALUES('after',public.fn_cash_pot_conservation_check(24));
SELECT pg_temp.cash_connected_assert((SELECT result FROM cash_results WHERE label='before')=
 (SELECT result FROM cash_results WHERE label='after')
 AND (SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM financial_alerts f)=(SELECT rows FROM cash_original_financial),
 'complete evidence does not change financial results or existing deduped alert bytes');
SELECT pg_temp.cash_connected_assert((SELECT count(*)=1 AND min(anomaly_rows)=22 FROM ca_cash_pot_check_evidence)
 AND (SELECT count(*)=22 FROM ca_cash_pot_check_anomalies)
 AND (SELECT count(*)=2 FROM operational_alert_events e JOIN financial_alerts f
   ON e.payload->>'financial_alert_id'=f.id::text
   WHERE e.source='cash-pot-conservation-measurement'
   AND e.event_key=(e.payload->>'check_id')||':'||(e.payload->>'condition_kind')
   AND f.source='fn_cash_pot_conservation_check'
   AND f.context->>'kind'=e.payload->>'condition_kind'
   AND e.payload->>'stored_omitted_count'='0')
 AND (SELECT count(*)=1 FROM operational_alert_events WHERE source='cash-pot-conservation-measurement'
   AND payload->>'condition_kind'='no_winner_recorded' AND payload->>'preview_count'='20'
   AND payload->>'preview_omitted_count'='1' AND (payload->>'condition_amount')::numeric=620)
 AND (SELECT count(*)=1 FROM operational_alert_events WHERE source='cash-pot-conservation-measurement'
   AND payload->>'condition_kind'='pot_not_distributed' AND payload->>'preview_count'='1'
   AND payload->>'preview_omitted_count'='0' AND (payload->>'condition_amount')::numeric=1),
 'complete 22-row evidence and both exact original financial links reach actual operational store');
SELECT pg_temp.cash_connected_assert(NOT EXISTS(SELECT 1 FROM ca_drift_incidents)
 AND NOT EXISTS(SELECT 1 FROM ca_incident_events) AND NOT EXISTS(SELECT 1 FROM ca_incident_file_failures)
 AND (SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM notifications n) IS NOT DISTINCT FROM (SELECT notifications FROM cash_before),
 'cash severity policy retained: no fabricated incident or notification');
-- Test actual insert (rather than deduped return) with the candidate. Reset only
-- to this savepoint afterward, retaining originals and all earlier receipts.
SAVEPOINT new_cash_alerts;
UPDATE financial_alerts SET resolved=true,resolved_at=now(),resolution='Isolated fixture fresh-alert path';
INSERT INTO cash_results VALUES('fresh',public.fn_cash_pot_conservation_check(24));
SELECT pg_temp.cash_connected_assert((SELECT count(*)=4 FROM financial_alerts WHERE source='fn_cash_pot_conservation_check')
 AND (SELECT result FROM cash_results WHERE label='fresh')=(SELECT result FROM cash_results WHERE label='before')
 AND (SELECT count(*)=2 FROM ca_cash_pot_check_evidence)
 AND (SELECT count(*)=4 FROM operational_alert_events WHERE source='cash-pot-conservation-measurement')
 AND NOT EXISTS(SELECT 1 FROM ca_drift_incidents) AND NOT EXISTS(SELECT 1 FROM ca_incident_file_failures),
 'candidate fresh financial inserts traverse unchanged real bridge policy');
ROLLBACK TO new_cash_alerts;
-- An allowed alert on the same real graph must still reach the durable inbox.
INSERT INTO ca_incident_recipients(user_id,scope,active,senior)
 VALUES('47965354-0e56-43ef-931c-ddaab82af765','platform',true,true);
CREATE FUNCTION pg_temp.cash_graph_control(p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_alert uuid;
BEGIN
 v_alert:=public.fn_raise_server_financial_alert('critical','postHandTasks.leave_pending_failed',
 'Isolated cash connected graph control: leave_pending failed for hand #17',
 '{"table_id":"10000000-0000-4000-8000-000000000001","hand_number":17,"error":"supabase_timeout","club_id":"fade0000-0000-0000-0000-000000000001","amount":12}'::jsonb,
 'cash-connected:'||p_label,NULL);
 IF NOT EXISTS(SELECT 1 FROM ca_drift_incidents i JOIN notifications n ON n.data->>'incident_id'=i.id::text
   JOIN operational_notification_destinations d ON d.notification_id=n.id
   JOIN operational_alert_events e ON e.id=d.inbox_event_id
   WHERE i.metadata->>'alert_id'=v_alert::text AND n.user_id='47965354-0e56-43ef-931c-ddaab82af765'
   AND e.source='owner-operational-notifications' AND e.event_key=n.id::text
   AND e.payload->'original_notification'->'data'->>'incident_id'=i.id::text AND d.last_error IS NULL)
 THEN RAISE EXCEPTION USING ERRCODE='ZC410',MESSAGE='actual connected inbox receipt missing'; END IF;
END $$;
-- A disconnected real trigger must fail this same receipt assertion. This
-- savepoint changes fixture wiring only; no replacement function or fake inbox.
SAVEPOINT disconnected_control;
ALTER TABLE financial_alerts DISABLE TRIGGER trg_ca_financial_alert_incident;
DO $$ DECLARE rejected boolean:=false; BEGIN
 BEGIN PERFORM pg_temp.cash_graph_control('disconnected'); EXCEPTION WHEN SQLSTATE 'ZC410' THEN rejected:=true; END;
 PERFORM pg_temp.cash_connected_assert(rejected,'disabled real bridge rejected by delivery assertion');
END $$;
ROLLBACK TO disconnected_control;
SELECT pg_temp.cash_graph_control('connected');
SELECT pg_temp.cash_connected_assert(NOT EXISTS(SELECT 1 FROM ca_incident_file_failures)
 AND NOT EXISTS(SELECT 1 FROM ca_incident_events WHERE kind='notify_failed')
 AND pg_temp.cash_business_snapshot()=(SELECT money FROM cash_before)
 AND (SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM hand_history h)=(SELECT hands FROM cash_subjects)
 AND (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM push_outbox p) IS NOT DISTINCT FROM (SELECT pushes FROM cash_before),
 'no hidden graph failure, money change, hand rewrite, or personal push');
CREATE TEMP TABLE cash_preserved AS SELECT
 (SELECT jsonb_agg(to_jsonb(h) ORDER BY check_id) FROM ca_cash_pot_check_evidence h) evidence,
 (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM operational_alert_events e) inbox,
 (SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM financial_alerts f) financial;
\ir ../../supabase/components/cash-pot-check-evidence.rollback.sql
\ir ../../supabase/components/cash-pot-check-evidence.rollback.sql
SELECT pg_temp.cash_connected_assert(md5(pg_get_functiondef('public.fn_cash_pot_conservation_check(integer)'::regprocedure))='484ca087624199de5a28678a2799ff75'
 AND (SELECT jsonb_agg(to_jsonb(h) ORDER BY check_id) FROM ca_cash_pot_check_evidence h)=(SELECT evidence FROM cash_preserved)
 AND (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM operational_alert_events e)=(SELECT inbox FROM cash_preserved)
 AND (SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM financial_alerts f)=(SELECT financial FROM cash_preserved),
 'paired source rollback and replay retain exact complete evidence and original financial/inbox rows');
SELECT 'CASH_CONNECTED_ASSERTIONS_COMPLETED; requires independent rollback/source/cleanup proof';
ROLLBACK;
-- A fresh committed snapshot observes that all owned qualification rows and the
-- fixture-only checker/install surfaces rolled back; the adapter then performs
-- its unchanged original core/notification observers and real invoice leaf.
BEGIN READ ONLY;
DO $$ BEGIN
 IF to_regprocedure('public.fn_cash_pot_conservation_check(integer)') IS NOT NULL
   OR to_regclass('public.ca_cash_pot_check_evidence') IS NOT NULL
   OR to_regclass('public.ca_cash_pot_check_anomalies') IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.hand_history)
   OR EXISTS(SELECT 1 FROM public.financial_alerts)
   OR EXISTS(SELECT 1 FROM public.operational_alert_events WHERE source='cash-pot-conservation-measurement')
 THEN RAISE EXCEPTION 'cash connected qualification did not roll back exact owned source and subjects'; END IF;
END $$;
COMMIT;
