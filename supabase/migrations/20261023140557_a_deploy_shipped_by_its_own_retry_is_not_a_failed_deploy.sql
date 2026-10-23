-- 20261023140557_a_deploy_shipped_by_its_own_retry_is_not_a_failed_deploy.sql
--
-- A DEPLOY SHIPPED BY ITS OWN RETRY IS NOT A FAILED DEPLOY (2026-10-23)
--
-- The Hetzner release transaction refuses a cutover it cannot finish inside
-- the break's proof budget and restores the sealed release; the workflow then
-- retries the same exact SHA. Run 39902613436 attempt 1 (attempt row 1166,
-- 05:12 UTC) was refused that way and attempt 2 (row 1167, 06:12 UTC) shipped
-- 734578ad. The daily digest counted only the stood-down "protected main had
-- moved to <sha>" rows as recovered, so a refused first attempt that its own
-- retry shipped still raised DailyDigest.deploy_failed.
--
-- fn_sp_daily_metrics_compute now also counts a not-shipped attempt as shipped
-- when the SAME target SHA shipped later within twelve hours (the existing
-- supersession window). A target that never shipped stays a failure. The new
-- figure is reported as 'retried' beside 'superseded'. Nothing else in the
-- function changes; the rewrite refuses if the expression it replaces moved.

-- @live-proof: position('AS retried' IN pg_get_functiondef('public.fn_sp_daily_metrics_compute(date)'::regprocedure)) > 0

BEGIN;

DO $mig$
DECLARE
  v_old_head text := $q$'deploys', (SELECT jsonb_build_object('attempted', count(*), 'shipped', count(*) FILTER (WHERE a.shipped OR a.superseded),
                                     'superseded', count(*) FILTER (WHERE a.superseded))$q$;
  v_new_head text := $q$'deploys', (SELECT jsonb_build_object('attempted', count(*), 'shipped', count(*) FILTER (WHERE a.shipped OR a.superseded OR a.retried),
                                     'superseded', count(*) FILTER (WHERE a.superseded),
                                     'retried', count(*) FILTER (WHERE a.retried AND NOT a.superseded))$q$;
  v_old_tail text := $q$AND y.at BETWEEN x.at - interval '12 hours' AND x.at + interval '12 hours')) AS superseded
                          FROM public.ca_engine_deploy_attempts x WHERE x.at >= s AND x.at < e) a),$q$;
  v_new_tail text := $q$AND y.at BETWEEN x.at - interval '12 hours' AND x.at + interval '12 hours')) AS superseded,
                               /* A REFUSED ATTEMPT THAT ITS OWN RETRY SHIPPED DID SHIP
                                  (2026-10-23): the same exact target shipped later
                                  within the same twelve-hour window. */
                               (NOT x.shipped AND EXISTS (
                                  SELECT 1 FROM public.ca_engine_deploy_attempts z
                                   WHERE z.shipped
                                     AND z.target_sha = x.target_sha
                                     AND z.at > x.at
                                     AND z.at <= x.at + interval '12 hours')) AS retried
                          FROM public.ca_engine_deploy_attempts x WHERE x.at >= s AND x.at < e) a),$q$;
  v_def text;
BEGIN
  v_def := pg_get_functiondef('public.fn_sp_daily_metrics_compute(date)'::regprocedure);
  IF position('AS retried' IN v_def) > 0 THEN
    RETURN;
  END IF;
  IF position(v_old_head IN v_def) = 0 OR position(v_old_tail IN v_def) = 0 THEN
    RAISE EXCEPTION 'fn_sp_daily_metrics_compute no longer contains the deploys expression this migration rewrites';
  END IF;
  v_def := replace(replace(v_def, v_old_head, v_new_head), v_old_tail, v_new_tail);
  EXECUTE v_def;
END $mig$;

COMMIT;
