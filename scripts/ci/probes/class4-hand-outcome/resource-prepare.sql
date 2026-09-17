-- Disposable fixture only. The driver caps this ENTIRE setup process at60s.
-- Minimal synthetic receipts reproduce index cardinality, not the production
-- 8.8GB payload footprint, real financial facts or cold-cache behavior.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='3s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'class4_native_'||replace(current_setting('app.class4_execution_uuid'),'-','')
    OR current_setting('server_version_num')::integer<>170011
    OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM public.financial_alerts)
    OR EXISTS(SELECT 1 FROM public.hand_atomic_commits)
    OR EXISTS(SELECT 1 FROM public.ca_drift_incidents)
    OR md5(pg_get_functiondef('public.fn_resolve_settled_financial_alerts(boolean,integer)'::regprocedure))<>'0874e7e5fa2a2b3b68bc8d3cdc7de8ab'
 THEN RAISE EXCEPTION 'resource fixture requires exact empty owned preimage'; END IF;
END $$;
\ir ../../../../supabase/components/class4-hand-outcome-evidence.sql
SET LOCAL session_replication_role=replica;
-- This owned empty fixture loads MD5 UUIDs across a 2.6M-row random B-tree.
-- Build the UUID unique index and the 256-table composite primary key once
-- after loading instead of maintaining both B-trees for each inserted row.
-- The sequential hand-number unique index, all row expressions and durability
-- settings stay unchanged. Both exact constraints and the existing full
-- source/schema guard must pass before any measurement.
ALTER TABLE public.hand_atomic_commits DROP CONSTRAINT hand_atomic_commits_hand_id_key;
ALTER TABLE public.hand_atomic_commits DROP CONSTRAINT hand_atomic_commits_pkey;
INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result,
 post_commit_payload,post_commit_request_hash,post_commit_payload_hash,post_commit_completed_at,post_commit_result)
SELECT md5('class4-resource-table:'||(i%256))::uuid,8000000+i,md5('class4-resource-hand:'||i)::uuid,
 repeat('a',64),'{}'::jsonb,
 CASE WHEN i<=5001 THEN '{"version":1}'::jsonb END,
 CASE WHEN i<=5001 THEN repeat('b',64) END,
 CASE WHEN i<=5001 THEN encode(extensions.digest(convert_to('{"version":1}'::jsonb::text,'UTF8'),'sha256'),'hex') END,
 CASE WHEN i<=5001 THEN '2026-09-17T00:00:00Z'::timestamptz END,
 CASE WHEN i<=5001 THEN jsonb_build_object('ok',true,'hand_id',md5('class4-resource-hand:'||i)::uuid,'hand_number',8000000+i) END
FROM generate_series(1,2600000) s(i);
ALTER TABLE public.hand_atomic_commits
 ADD CONSTRAINT hand_atomic_commits_hand_id_key UNIQUE (hand_id);
ALTER TABLE public.hand_atomic_commits
 ADD CONSTRAINT hand_atomic_commits_pkey PRIMARY KEY (table_id, hand_number);
-- Existing replay verifies every exact constraint/index and valid/ready state.
\ir ../../../../supabase/components/class4-hand-outcome-evidence.sql
-- Original aggregate history:42051 total -3363 unresolved =38688 resolved.
INSERT INTO public.financial_alerts(id,severity,source,message,context,resolved,created_at)
SELECT md5('class4-resource-history:'||i)::uuid,'warning','synthetic.resolved_history',
 'Bounded resource fixture history','{}',true,'2026-09-01T00:00:00Z'::timestamptz
FROM generate_series(1,38688) s(i);
-- Original unresolved source buckets:12 Class4,4 Class1,1 Class2,0 Class3,
--3346 other. These are fabricated negative contexts, never captured row data.
INSERT INTO public.financial_alerts(id,severity,source,message,context,resolved,created_at)
SELECT md5('class4-resource-negative:'||i)::uuid,'warning',
 CASE WHEN i<=12 THEN 'postHandTasks.hand_history_failed'
      WHEN i<=16 THEN 'fn_payout_guarantee_check'
      WHEN i=17 THEN 'fn_tournament_payout_reconcile' ELSE 'synthetic.other_unresolved' END,
 'Bounded resource fixture unresolved',
 CASE WHEN i<=12 THEN jsonb_build_object('channel','server_rpc','table_id',md5('unknown-table')::uuid,'hand_number',9000000+i)
      WHEN i<=16 THEN jsonb_build_object('kind','earner_not_paid','user_id',md5('unknown-user')::uuid,'tournament_id',md5('unknown-event')::uuid,'short',10)
      WHEN i=17 THEN '{"issues":[{"issue":"unresolved_fixture"}]}'::jsonb ELSE '{}'::jsonb END
 || jsonb_build_object('padding',repeat('x',561)),false,'2026-09-02T00:00:00Z'::timestamptz
FROM generate_series(1,3363) s(i);
-- One incompressible context at least as large as the observed maximum74129.
UPDATE public.financial_alerts SET context=context||jsonb_build_object('large_context',
 (SELECT string_agg(md5('bounded-context:'||i),'') FROM generate_series(1,2317) s(i)))
WHERE id=md5('class4-resource-negative:3363')::uuid;
-- Five thousand eligible receipts and one beyond the configured batch frontier.
INSERT INTO public.financial_alerts(id,severity,source,message,context,resolved,created_at)
SELECT md5('class4-resource-positive:'||i)::uuid,'critical',
 CASE WHEN i%2=0 THEN 'postHandTasks.hand_history_failed' ELSE 'ServerTableEngine.authoritative_hand_semantic_refusal' END,
 'Bounded resource fixture exact original',jsonb_build_object('channel','server_rpc',
 'table_id',md5('class4-resource-table:'||(i%256))::uuid,'hand_number',8000000+i,'padding',repeat('x',561),
 'hand_request_identity_v1',jsonb_build_object('version',1,'post_commit_required',true,
 'table_id',md5('class4-resource-table:'||(i%256))::uuid,'hand_number',8000000+i,'hand_id',md5('class4-resource-hand:'||i)::uuid)),
 false,'2026-09-03T00:00:00Z'::timestamptz+i*interval '1 microsecond'
FROM generate_series(1,5001) s(i);
-- Conservative full mirror coverage for the added eligible frontier.
INSERT INTO public.ca_drift_incidents(id,source,dedupe_key,metadata,status)
SELECT md5('class4-resource-mirror:'||i)::uuid,'financial_alerts:'||
 CASE WHEN i%2=0 THEN 'postHandTasks.hand_history_failed' ELSE 'ServerTableEngine.authoritative_hand_semantic_refusal' END,
 'class4-resource:'||i,jsonb_build_object('alert_id',md5('class4-resource-positive:'||i)::uuid),'open'
FROM generate_series(1,5001) s(i);
SET LOCAL session_replication_role=origin;
ANALYZE public.financial_alerts;
ANALYZE public.hand_atomic_commits;
ANALYZE public.ca_drift_incidents;
DO $$ BEGIN
 IF (SELECT count(*) FROM public.financial_alerts)<>47052
    OR (SELECT count(*) FROM public.financial_alerts WHERE resolved IS NOT TRUE)<>8364
    OR (SELECT count(*) FROM public.hand_atomic_commits)<>2600000
    OR (SELECT count(*) FROM public.ca_drift_incidents)<>5001
    OR current_setting('session_replication_role')<>'origin'
 THEN RAISE EXCEPTION 'resource preparation cardinality or authority mismatch'; END IF;
END $$;
COMMIT;
SELECT 'CLASS4_RESOURCE_SETUP='||jsonb_build_object('alerts',47052,'unresolved',8364,
 'observed_unresolved',3363,'eligible_frontier',5001,'mirrors',5001,'canonical_rows',2600000,
 'alert_relation_bytes',pg_total_relation_size('public.financial_alerts'),
 'canonical_relation_bytes',pg_total_relation_size('public.hand_atomic_commits'),
 'work_mem',current_setting('work_mem'),'shared_buffers',current_setting('shared_buffers'),
 'max_wal_size',current_setting('max_wal_size'),'fsync',current_setting('fsync'),
 'full_page_writes',current_setting('full_page_writes'),'wal_level',current_setting('wal_level'),
 'maintenance_work_mem',current_setting('maintenance_work_mem'),
 'cold_cache_or_production_payload_equivalence',false)::text;
