\set ON_ERROR_STOP on
SET plan_cache_mode=force_generic_plan;
PREPARE oldfresh(uuid,timestamptz,timestamptz) AS SELECT EXISTS(SELECT 1 FROM public.accounting_period_recompute_requests q WHERE q.club_id=$1 AND q.period_start='2026-10-12' AND q.period_end='2026-10-18' AND q.status='complete' AND q.attempted_at IS NOT NULL AND q.last_requested_at<=q.attempted_at AND q.last_result->>'accounting_version'='2' AND q.last_result->>'status'='ready' AND q.last_result->>'club_id'=q.club_id::text AND q.last_result->>'period_start'=q.period_start::text AND q.last_result->>'period_end'=q.period_end::text AND NOT EXISTS(SELECT 1 FROM public.accounting_effective_cash_rake_sources s WHERE s.club_id=q.club_id AND s.earned_at>=$2 AND s.earned_at<$3 AND s.recorded_at>q.attempted_at-interval '1 minute') AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f WHERE f.club_id=q.club_id AND f.charged_at<$3 AND f.recorded_at>q.attempted_at-interval '1 minute')) ready;
PREPARE newfresh(uuid,timestamptz,timestamptz) AS SELECT EXISTS(SELECT 1 FROM public.accounting_period_recompute_requests q WHERE q.club_id=$1 AND q.period_start='2026-10-12' AND q.period_end='2026-10-18' AND q.status='complete' AND q.attempted_at IS NOT NULL AND q.last_requested_at<=q.attempted_at AND q.last_result->>'accounting_version'='2' AND q.last_result->>'status'='ready' AND q.last_result->>'club_id'=q.club_id::text AND q.last_result->>'period_start'=q.period_start::text AND q.last_result->>'period_end'=q.period_end::text AND NOT EXISTS(SELECT 1 FROM (SELECT s.earned_at FROM public.accounting_cash_rake_sources s WHERE s.club_id=q.club_id AND s.recorded_at>q.attempted_at-interval '1 minute' OFFSET 0) s WHERE s.earned_at>=$2 AND s.earned_at<$3) AND NOT EXISTS(SELECT 1 FROM (SELECT a.source_id FROM public.accounting_cash_atomic_contract_admissions a WHERE a.admitted_at>q.attempted_at-interval '1 minute' OFFSET 0) a CROSS JOIN LATERAL (SELECT s.club_id,s.earned_at FROM public.accounting_cash_rake_sources s WHERE s.id=a.source_id OFFSET 0) s WHERE s.club_id=q.club_id AND s.earned_at>=$2 AND s.earned_at<$3) AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f WHERE f.club_id=q.club_id AND f.charged_at<$3 AND f.recorded_at>q.attempted_at-interval '1 minute')) ready;

CREATE TABLE local_plan_results(label text,plan jsonb);
DO $plan$ DECLARE o jsonb;n jsonb;BEGIN
 EXECUTE $q$EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) EXECUTE oldfresh('e14bc9f7-736d-425f-8f2c-e78305ebac1d','2026-10-12 07:00Z','2026-10-19 07:00Z')$q$ INTO o;
 EXECUTE $q$EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) EXECUTE newfresh('e14bc9f7-736d-425f-8f2c-e78305ebac1d','2026-10-12 07:00Z','2026-10-19 07:00Z')$q$ INTO n;
 RAISE NOTICE 'OLD_GENERIC_PLAN %',o; RAISE NOTICE 'NEW_GENERIC_PLAN %',n;
 IF o::text NOT LIKE '%GREATEST%' OR n::text NOT LIKE '%accounting_cash_rake_sources_club_recorded%' THEN RAISE EXCEPTION 'generic_plan_contract_refused';END IF;
 INSERT INTO local_plan_results VALUES('old',o),('new',n);
END $plan$;
SELECT label,plan->0->>'Execution Time' execution_ms FROM local_plan_results ORDER BY label;

PREPARE oldsplit(uuid,timestamptz,timestamptz,timestamptz) AS SELECT EXISTS(SELECT FROM public.accounting_effective_cash_rake_sources s WHERE s.club_id=$1 AND s.earned_at>=$2 AND s.earned_at<$3 AND s.recorded_at>$4);
PREPARE newsplit(uuid,timestamptz,timestamptz,timestamptz) AS SELECT EXISTS(SELECT FROM(SELECT s.earned_at FROM public.accounting_cash_rake_sources s WHERE s.club_id=$1 AND s.recorded_at>$4 OFFSET 0)s WHERE s.earned_at>=$2 AND s.earned_at<$3) OR EXISTS(SELECT FROM(SELECT a.source_id FROM public.accounting_cash_atomic_contract_admissions a WHERE a.admitted_at>$4 OFFSET 0)a CROSS JOIN LATERAL(SELECT s.club_id,s.earned_at FROM public.accounting_cash_rake_sources s WHERE s.id=a.source_id OFFSET 0)s WHERE s.club_id=$1 AND s.earned_at>=$2 AND s.earned_at<$3);
DO $plan$ DECLARE o jsonb;n jsonb;BEGIN
 EXECUTE $q$EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) EXECUTE oldsplit('e14bc9f7-736d-425f-8f2c-e78305ebac1d','2026-10-12 07:00Z','2026-10-19 07:00Z','2026-10-20 15:41:33.726198Z')$q$ INTO o;
 EXECUTE $q$EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) EXECUTE newsplit('e14bc9f7-736d-425f-8f2c-e78305ebac1d','2026-10-12 07:00Z','2026-10-19 07:00Z','2026-10-20 15:41:33.726198Z')$q$ INTO n;
 IF o::text NOT LIKE '%GREATEST%' OR n::text NOT LIKE '%accounting_cash_rake_sources_club_recorded%' THEN RAISE EXCEPTION 'split_generic_plan_contract_refused';END IF;
 INSERT INTO local_plan_results VALUES('old_split',o),('new_split',n);
END $plan$;
SELECT label,plan->0->>'Execution Time' execution_ms FROM local_plan_results ORDER BY label;
