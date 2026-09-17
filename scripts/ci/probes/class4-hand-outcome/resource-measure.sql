-- Actual unchanged candidate and service-role calls; all measured writes roll back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='3s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'class4_native_'||replace(current_setting('app.class4_execution_uuid'),'-','')
    OR current_setting('session_replication_role')<>'origin'
    OR md5(pg_get_functiondef('public.fn_resolve_settled_financial_alerts(boolean,integer)'::regprocedure))<>'edd4397b2daeadade433cd01a26a1c70'
    OR (SELECT count(*) FROM public.hand_atomic_commits)<>2600000
    OR (SELECT count(*) FROM public.financial_alerts)<>47052
    OR (SELECT count(*) FROM public.financial_alerts WHERE resolved IS NOT TRUE)<>8364
    OR (SELECT count(*) FROM public.ca_drift_incidents WHERE status='open')<>5001
 THEN RAISE EXCEPTION 'resource measurement requires exact prepared candidate'; END IF;
END $$;
CREATE TEMP TABLE class4_resource_results(stage text PRIMARY KEY,result jsonb NOT NULL);
CREATE TEMP TABLE class4_resource_plans(stage text PRIMARY KEY,plan jsonb NOT NULL);
CREATE TEMP TABLE class4_resource_before AS SELECT md5(string_agg(md5(to_jsonb(a)::text),'' ORDER BY a.id)) original_digest
FROM public.financial_alerts a WHERE a.message<>'Bounded resource fixture exact original';
GRANT SELECT,INSERT ON class4_resource_results,class4_resource_plans TO service_role;
SET LOCAL ROLE service_role;
DO $measure$ DECLARE p jsonb; BEGIN
 EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,WAL,TIMING OFF,FORMAT JSON) INSERT INTO pg_temp.class4_resource_results SELECT ''preview'',public.fn_resolve_settled_financial_alerts(false,5000)' INTO p;
 INSERT INTO pg_temp.class4_resource_plans VALUES('preview',p);
END $measure$;
DO $measure$ DECLARE p jsonb; BEGIN
 EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,WAL,TIMING OFF,FORMAT JSON) INSERT INTO pg_temp.class4_resource_results SELECT ''first_apply'',public.fn_resolve_settled_financial_alerts(true,5000)' INTO p;
 INSERT INTO pg_temp.class4_resource_plans VALUES('first_apply',p);
END $measure$;
RESET ROLE;
DO $$ BEGIN
 IF (SELECT result->>'refused_hand_released' FROM class4_resource_results WHERE stage='preview') IS DISTINCT FROM '5000'
    OR (SELECT result->>'refused_hand_released' FROM class4_resource_results WHERE stage='first_apply') IS DISTINCT FROM '5000'
    OR (SELECT count(*) FROM public.financial_alerts WHERE message='Bounded resource fixture exact original' AND resolved IS TRUE)<>5000
    OR (SELECT count(*) FROM public.financial_alerts WHERE message='Bounded resource fixture exact original' AND resolved IS NOT TRUE)<>1
    OR NOT EXISTS(SELECT 1 FROM public.financial_alerts WHERE id=md5('class4-resource-positive:5001')::uuid AND resolved IS FALSE)
    OR EXISTS(SELECT 1 FROM class4_resource_results WHERE result->>'settled_after_alert'<>'0' OR result->>'overpay_absorbed'<>'0' OR result->>'post_commit_applied'<>'0')
 THEN RAISE EXCEPTION 'p_limit5000 frontier/count/order changed'; END IF;
END $$;
SET LOCAL ROLE service_role;
DO $measure$ DECLARE p jsonb; BEGIN
 EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,WAL,TIMING OFF,FORMAT JSON) INSERT INTO pg_temp.class4_resource_results SELECT ''remaining_apply'',public.fn_resolve_settled_financial_alerts(true,5000)' INTO p;
 INSERT INTO pg_temp.class4_resource_plans VALUES('remaining_apply',p);
END $measure$;
RESET ROLE;
DO $$ BEGIN
 IF (SELECT result->>'refused_hand_released' FROM class4_resource_results WHERE stage='remaining_apply') IS DISTINCT FROM '1'
    OR (SELECT count(*) FROM public.financial_alerts WHERE resolved IS NOT TRUE)<>3363
    OR (SELECT count(*) FROM public.financial_alerts WHERE message='Bounded resource fixture exact original' AND resolved IS TRUE)<>5001
    OR (SELECT original_digest FROM class4_resource_before) IS DISTINCT FROM
       (SELECT md5(string_agg(md5(to_jsonb(a)::text),'' ORDER BY a.id)) FROM public.financial_alerts a WHERE a.message<>'Bounded resource fixture exact original')
    OR (SELECT count(*) FROM public.ca_drift_incidents i JOIN public.financial_alerts a ON i.metadata->>'alert_id'=a.id::text WHERE i.status='resolved' AND position(a.resolution IN i.resolution)>0 AND a.context->>'resolution'=a.resolution)<>5001
    OR (SELECT count(*) FROM class4_resource_plans)<>3
    OR EXISTS(SELECT 1 FROM class4_resource_plans WHERE (plan->0->>'Execution Time')::numeric>=20000 OR plan->0->'Execution Time' IS NULL)
 THEN RAISE EXCEPTION 'backlog drain, negative preservation or20s resource bound failed'; END IF;
END $$;
SELECT 'CLASS4_RESOURCE_RESULT='||jsonb_build_object('passed',true,'p_limit',5000,
 'remaining_negative_alerts',3363,'eligible_resolved_in_two_calls',5001,
 'plans',(SELECT jsonb_object_agg(stage,plan) FROM class4_resource_plans),
 'results',(SELECT jsonb_object_agg(stage,result) FROM class4_resource_results),
 'work_mem',current_setting('work_mem'),'shared_buffers',current_setting('shared_buffers'),
 'peak_rss_measured',false,'money_writer_qualified',false,'typed_rollback_qualified',false,
 'cold_cache_or_production_payload_equivalence',false)::text;
ROLLBACK;
DO $$ BEGIN
 IF (SELECT count(*) FROM public.financial_alerts WHERE resolved IS NOT TRUE)<>8364
    OR (SELECT count(*) FROM public.financial_alerts WHERE message='Bounded resource fixture exact original' AND resolved IS TRUE)<>0
    OR (SELECT count(*) FROM public.ca_drift_incidents WHERE status='open')<>5001
    OR EXISTS(SELECT 1 FROM public.ca_incident_events)
 THEN RAISE EXCEPTION 'resource measurement rollback not observed'; END IF;
END $$;
\ir ../../../../supabase/components/class4-hand-outcome-evidence.rollback.sql
DO $$ BEGIN
 IF md5(pg_get_functiondef('public.fn_resolve_settled_financial_alerts(boolean,integer)'::regprocedure))<>'0874e7e5fa2a2b3b68bc8d3cdc7de8ab'
 THEN RAISE EXCEPTION 'resource source rollback mismatch'; END IF;
END $$;
-- The finite driver independently stops PostgreSQL and removes its owned cluster,
-- including the committed synthetic preparation. No production cleanup runs.
