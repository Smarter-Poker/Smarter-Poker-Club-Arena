-- SOURCE ONLY / UNRUN. Protected native owner supplies the execution UUID
-- and an empty, exact pinned catalog. Never run against production.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='3s';
CREATE FUNCTION pg_temp.class4_assert(p_ok boolean,p_message text) RETURNS void
LANGUAGE plpgsql AS $$BEGIN IF p_ok IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'CLASS4 qualification: %',p_message; END IF; END$$;
SELECT pg_temp.class4_assert(
  current_user='postgres'
  AND current_setting('server_version_num')::integer BETWEEN 170000 AND 179999
  AND current_setting('app.class4_execution_uuid',true) ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND current_database()='class4_native_'||replace(current_setting('app.class4_execution_uuid',true),'-',''),
  'explicit disposable PG17 execution binding required');
SELECT pg_temp.class4_assert(
  NOT EXISTS(SELECT 1 FROM public.financial_alerts)
  AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits)
  AND NOT EXISTS(SELECT 1 FROM public.ca_drift_incidents),
  'empty subject relations required; qualification must never consume production rows');
SELECT pg_temp.class4_assert(
  md5(pg_get_functiondef('public.fn_resolve_settled_financial_alerts(boolean,integer)'::regprocedure))=
    '0874e7e5fa2a2b3b68bc8d3cdc7de8ab', 'exact original target required');
CREATE TEMP TABLE class4_source AS SELECT pg_get_functiondef(
  'public.fn_resolve_settled_financial_alerts(boolean,integer)'::regprocedure) preimage;
CREATE TEMP TABLE class4_cases(name text PRIMARY KEY,alert_id uuid UNIQUE,hand_id uuid UNIQUE,
  hand_number bigint UNIQUE,should_close boolean NOT NULL,source text NOT NULL,context jsonb);
INSERT INTO class4_cases(name,alert_id,hand_id,hand_number,should_close,source)
SELECT name,md5('class4-alert:'||name)::uuid,md5('class4-hand:'||name)::uuid,
       7000000+ordinality, name IN('exact_semantic','exact_history'),
       CASE WHEN name='exact_history' THEN 'postHandTasks.hand_history_failed'
         ELSE 'ServerTableEngine.authoritative_hand_semantic_refusal' END
FROM unnest(ARRAY['exact_semantic','exact_history','pending','later_hand_only','uuid_mismatch',
  'table_mismatch','client_rpc','text_only_rollback','bad_version','false_required',
  'malformed_uuid','scalar_identity','string_number','unsafe_number','completion_false',
  'completion_uuid_mismatch','completion_number_mismatch','missing_envelope_hash',
  'missing_envelope','unrelated_source'])WITH ORDINALITY names(name,ordinality);
UPDATE class4_cases SET context=jsonb_build_object(
  'channel','server_rpc','table_id','70000000-0000-4000-8000-000000000001',
  'hand_number',hand_number,'error','atomic hand commit refused (atomic_hand_rolled_back): fixture',
  'hand_request_identity_v1',jsonb_build_object('version',1,
    'table_id','70000000-0000-4000-8000-000000000001','hand_number',hand_number,
    'hand_id',hand_id,'post_commit_required',true));
UPDATE class4_cases SET context=jsonb_set(context,'{channel}','"client_rpc"')WHERE name='client_rpc';
UPDATE class4_cases SET context=context-'hand_request_identity_v1'WHERE name='text_only_rollback';
UPDATE class4_cases SET context=jsonb_set(context,'{hand_request_identity_v1,version}','"1"')WHERE name='bad_version';
UPDATE class4_cases SET context=jsonb_set(context,'{hand_request_identity_v1,post_commit_required}','false')WHERE name='false_required';
UPDATE class4_cases SET context=jsonb_set(context,'{hand_request_identity_v1,hand_id}','"not-a-uuid"')WHERE name='malformed_uuid';
UPDATE class4_cases SET context=jsonb_set(context,'{hand_request_identity_v1}','[]')WHERE name='scalar_identity';
UPDATE class4_cases SET context=jsonb_set(context,'{hand_request_identity_v1,hand_number}',to_jsonb(hand_number::text))WHERE name='string_number';
UPDATE class4_cases SET context=jsonb_set(jsonb_set(context,'{hand_number}','9007199254740992'),
  '{hand_request_identity_v1,hand_number}','9007199254740992')WHERE name='unsafe_number';
UPDATE class4_cases SET context=jsonb_set(jsonb_set(context,'{table_id}',
  '"70000000-0000-4000-8000-000000000002"'),'{hand_request_identity_v1,table_id}',
  '"70000000-0000-4000-8000-000000000002"')WHERE name='table_mismatch';
UPDATE class4_cases SET source='unrelated.received_fixture'WHERE name='unrelated_source';

-- Owner-injected unit subjects, not an invocation or proof of the money writer.
-- Suppress seed-trigger side effects only within this empty disposable fixture.
-- Restore origin BEFORE the guarded install and every resolver invocation.
SET LOCAL session_replication_role=replica;
INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result,
  post_commit_payload,post_commit_request_hash,post_commit_payload_hash,
  post_commit_completed_at,post_commit_result)
SELECT '70000000-0000-4000-8000-000000000001',
  CASE WHEN name='unsafe_number' THEN 9007199254740992
    ELSE hand_number+CASE WHEN name='later_hand_only' THEN 1000000 ELSE 0 END END,
  CASE WHEN name='uuid_mismatch' THEN md5('other-request:'||name)::uuid ELSE hand_id END,
  repeat('a',64),jsonb_build_object('hand_id','006d0bad-0000-4000-8000-000000000001'),
  CASE WHEN name='missing_envelope' THEN NULL ELSE '{"version":1}'::jsonb END,
  repeat('b',64),CASE WHEN name='missing_envelope_hash' THEN NULL ELSE
    encode(extensions.digest(convert_to('{"version":1}'::jsonb::text,'UTF8'),'sha256'),'hex') END,
  CASE WHEN name='pending' THEN NULL ELSE '2026-09-15T04:32:28.138880Z'::timestamptz END,
  jsonb_build_object('ok',name<>'completion_false',
    'hand_id',CASE WHEN name='completion_uuid_mismatch' THEN md5('wrong-completion')::uuid
      WHEN name='uuid_mismatch' THEN md5('other-request:'||name)::uuid ELSE hand_id END,
    'hand_number',CASE WHEN name='unsafe_number' THEN 9007199254740992
      ELSE hand_number+CASE WHEN name='completion_number_mismatch' THEN 1
        WHEN name='later_hand_only' THEN 1000000 ELSE 0 END END)
FROM class4_cases;
INSERT INTO public.financial_alerts(id,severity,source,message,context,resolved)
SELECT alert_id,'critical',source,'Synthetic native Class4 '||name,context,false FROM class4_cases;
\ir fixtures/class4-hand-outcome-evidence.originals.sql
-- Class 1 negative, Class 2 positive, Class 3 positive: legacy branches retain
-- their own exact rules. No wallet/payment row is created or changed here.
INSERT INTO public.financial_alerts(id,severity,source,message,context,resolved)VALUES
('70000000-0000-4000-8000-000000000101','critical','fn_payout_guarantee_check','Class1 control',
 '{"kind":"earner_not_paid","short":1,"user_id":"70000000-0000-4000-8000-000000000201","tournament_id":"70000000-0000-4000-8000-000000000202"}',false),
('70000000-0000-4000-8000-000000000102','critical','fn_tournament_payout_reconcile','Class2 control','{"issues":[{"issue":"overpaid"}]}',false);
INSERT INTO public.financial_alerts(id,severity,source,message,context,resolved)
SELECT '70000000-0000-4000-8000-000000000103','critical','ServerTableEngine.post_commit_obligations_pending',
 'Class3 control',jsonb_build_object('hand_id',hand_id),false FROM class4_cases WHERE name='exact_history';
INSERT INTO public.ca_drift_incidents(id,source,dedupe_key,metadata,status)
SELECT md5('class4-mirror:'||name)::uuid,'financial_alerts:'||source,'class4-native:'||name,
 jsonb_build_object('alert_id',alert_id),'open'FROM class4_cases WHERE should_close;
SET LOCAL session_replication_role=origin;
SELECT pg_temp.class4_assert(current_setting('session_replication_role')='origin','seed mode must be closed');
CREATE TEMP TABLE class4_original_rows AS
SELECT id,to_jsonb(a)row_before FROM public.financial_alerts a
 WHERE id IN('eb5460fe-1d65-481c-971b-957d94b7a0b0','dbb49c1a-ffed-46a0-b409-8a70f110d4d7');
CREATE TEMP TABLE class4_before_source AS
SELECT (SELECT jsonb_agg(to_jsonb(a)ORDER BY id)FROM public.financial_alerts a)alerts,
       (SELECT jsonb_agg(to_jsonb(c)ORDER BY hand_id)FROM public.hand_atomic_commits c)commits,
       (SELECT jsonb_agg(to_jsonb(i)ORDER BY id)FROM public.ca_drift_incidents i)mirrors;
CREATE TEMP TABLE class4_baseline AS SELECT public.fn_resolve_settled_financial_alerts(false,5000)result;
\ir ../../supabase/components/class4-hand-outcome-evidence.sql
SELECT pg_temp.class4_assert(
 (SELECT alerts IS NOT DISTINCT FROM(SELECT jsonb_agg(to_jsonb(a)ORDER BY id)FROM public.financial_alerts a)
 AND commits IS NOT DISTINCT FROM(SELECT jsonb_agg(to_jsonb(c)ORDER BY hand_id)FROM public.hand_atomic_commits c)
 AND mirrors IS NOT DISTINCT FROM(SELECT jsonb_agg(to_jsonb(i)ORDER BY id)FROM public.ca_drift_incidents i)
 FROM class4_before_source),'install must not change rows');
\ir ../../supabase/components/class4-hand-outcome-evidence.sql
SELECT pg_temp.class4_assert(
 md5(pg_get_functiondef('public.fn_resolve_settled_financial_alerts(boolean,integer)'::regprocedure))=
 'edd4397b2daeadade433cd01a26a1c70','exact install replay required');
\ir class4-hand-outcome-evidence.drift.sql
SELECT pg_temp.class4_assert(
 (SELECT split_part(preimage,'  -- CLASS 4:',1)=split_part(pg_get_functiondef(
  'public.fn_resolve_settled_financial_alerts(boolean,integer)'::regprocedure),'  -- CLASS 4 / STAGE 1',1)
 FROM class4_source),'Classes1–3 selection bytes unchanged');
CREATE TEMP TABLE class4_preview AS SELECT public.fn_resolve_settled_financial_alerts(false,5000)result;
SELECT pg_temp.class4_assert((SELECT(result->>'refused_hand_released')::int=2 FROM class4_preview),
 'only two exact completed original subjects preview');
SELECT pg_temp.class4_assert((SELECT
 (p.result->'settled_after_alert',p.result->'overpay_absorbed',p.result->'post_commit_applied')=
 (b.result->'settled_after_alert',b.result->'overpay_absorbed',b.result->'post_commit_applied')
 FROM class4_preview p CROSS JOIN class4_baseline b),'legacy branch preview results unchanged');
GRANT SELECT ON class4_cases TO service_role,authenticated;
SET LOCAL ROLE service_role;
CREATE TEMP TABLE class4_applied AS SELECT public.fn_resolve_settled_financial_alerts(true,5000)result;
SELECT pg_temp.class4_assert((SELECT(result->>'refused_hand_released')::int=2 FROM class4_applied),
 'real service-role resolver updates only exact completed originals');
RESET ROLE;
SELECT pg_temp.class4_assert((SELECT count(*) FROM class4_cases s
 JOIN public.financial_alerts a ON a.id=s.alert_id)=20 AND NOT EXISTS(
 SELECT 1 FROM class4_cases s JOIN public.financial_alerts a ON a.id=s.alert_id
 WHERE a.resolved IS DISTINCT FROM s.should_close),'all negatives remain unresolved');
SELECT pg_temp.class4_assert((SELECT count(*) FROM class4_original_rows o
 JOIN public.financial_alerts a USING(id))=2 AND NOT EXISTS(
 SELECT 1 FROM class4_original_rows o JOIN public.financial_alerts a USING(id)
 WHERE to_jsonb(a)IS DISTINCT FROM o.row_before),'historical resolved originals stay byte-identical');
SELECT pg_temp.class4_assert((SELECT count(*)=2 AND bool_and((
 i.status='resolved' AND position(a.resolution IN i.resolution)>0
 AND a.context->>'resolution'=a.resolution
 AND a.context->'hand_outcome_resolution_v1'->>'hand_id'=s.hand_id::text) IS TRUE)
 FROM class4_cases s JOIN public.financial_alerts a ON a.id=s.alert_id
 JOIN public.ca_drift_incidents i ON i.metadata->>'alert_id'=a.id::text
 WHERE s.should_close),
 'mirror must receive the exact truthful top-level receipt note');
SELECT pg_temp.class4_assert(
 (SELECT count(*)=3 AND bool_and(a.resolved=(a.id<>'70000000-0000-4000-8000-000000000101'::uuid))
 FROM public.financial_alerts a WHERE a.id IN(
 '70000000-0000-4000-8000-000000000101','70000000-0000-4000-8000-000000000102','70000000-0000-4000-8000-000000000103')),
 'Classes1–3 apply controls retain original behavior');
SELECT pg_temp.class4_assert(NOT has_table_privilege('service_role','public.hand_atomic_commits','UPDATE')
 AND NOT has_table_privilege('authenticated','public.hand_atomic_commits','UPDATE'),
 'caller JSON cannot write canonical completion');
-- Actual client producer overwrites a forged server channel.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','70000000-0000-4000-8000-000000000201',true);
SELECT set_config('request.jwt.claims','{"sub":"70000000-0000-4000-8000-000000000201","role":"authenticated"}',true);
SELECT public.fn_raise_financial_alert('warning','ServerTableEngine.authoritative_hand_semantic_refusal',
 'Synthetic forged provenance',(SELECT context FROM class4_cases WHERE name='exact_semantic'));
RESET ROLE;
SELECT pg_temp.class4_assert((SELECT count(*)=1 AND bool_and((context->>'channel'='client_rpc')IS TRUE)FROM public.financial_alerts
 WHERE message='Synthetic forged provenance'),'client API stamps its own channel');
SET LOCAL ROLE service_role;
SELECT pg_temp.class4_assert((public.fn_resolve_settled_financial_alerts(true,5000)->>'refused_hand_released')::int=0,
 'forged client identity and already-resolved subjects cannot resolve again');
RESET ROLE;
SELECT pg_temp.class4_assert((SELECT count(*)=1 AND bool_and(resolved IS FALSE)FROM public.financial_alerts
 WHERE message='Synthetic forged provenance'),'real client original stays actionable');
CREATE TEMP TABLE class4_before_rollback AS
SELECT(SELECT jsonb_agg(to_jsonb(a)ORDER BY id)FROM public.financial_alerts a)alerts,
 (SELECT jsonb_agg(to_jsonb(c)ORDER BY hand_id)FROM public.hand_atomic_commits c)commits,
 (SELECT jsonb_agg(to_jsonb(i)ORDER BY id)FROM public.ca_drift_incidents i)mirrors;
\ir ../../supabase/components/class4-hand-outcome-evidence.rollback.sql
SELECT pg_temp.class4_assert((SELECT preimage=pg_get_functiondef(
 'public.fn_resolve_settled_financial_alerts(boolean,integer)'::regprocedure)FROM class4_source),
 'rollback restores exact source');
SELECT pg_temp.class4_assert((SELECT
 alerts IS NOT DISTINCT FROM(SELECT jsonb_agg(to_jsonb(a)ORDER BY id)FROM public.financial_alerts a)
 AND commits IS NOT DISTINCT FROM(SELECT jsonb_agg(to_jsonb(c)ORDER BY hand_id)FROM public.hand_atomic_commits c)
 AND mirrors IS NOT DISTINCT FROM(SELECT jsonb_agg(to_jsonb(i)ORDER BY id)FROM public.ca_drift_incidents i)
 FROM class4_before_rollback),'rollback preserves every evidence/history row');
ROLLBACK;
-- External native owner must independently record session exit and empty
-- disposable database ownership cleanup. This file cannot certify its own exit.
