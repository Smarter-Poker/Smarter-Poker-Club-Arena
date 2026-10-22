-- 20261022042102_lightning_timing_correlation_scores_its_confidence_bound.sql
-- Five TIMING_CORRELATION findings (51, 141, 158, 159, Madness 50) were HIGH
-- on 23 to 34 paired hands with r 0.708 to 0.780, and all decayed to r about
-- 0.13 to 0.27 with more data. Detection is unchanged: the same hands,
-- sequential, correlation and follow-share thresholds still raise the signal.
-- Only the strength the correlation lends to the score changes: it is the
-- one-sided 99% Fisher-z lower confidence bound of r over corr_n paired hands,
-- tanh(atanh(r) - 2.326/sqrt(n-3)), so a short sample scores medium and a
-- strong long one still scores high. Follow-share scoring, DECISION_LATENCY,
-- every other pattern, peak retention and every existing signal row are
-- untouched. Owner, SECURITY DEFINER, search_path and grants are kept by
-- asserted substitution into the live definition.
-- @live-proof: (SELECT s LIKE '%latency_corr_lower_bound_99%' AND s LIKE '%tanh(atanh(LEAST(GREATEST(v_corr::double precision, -0.999999), 0.999999))%' AND s LIKE '%GREATEST(coalesce(v_corr_lb, 0), coalesce(v_follow, 0))%' AND s LIKE '%fisher_z_one_sided_99_lower_bound%' AND s LIKE '%(v_corr >= c_tc_min_corr OR v_follow >= c_tc_min_follow)%' AND p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'] AND has_function_privilege('service_role',p.oid,'EXECUTE') AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE p.oid='public.fn_lightning_integrity_report(uuid,jsonb,timestamptz)'::regprocedure)
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $patch$
DECLARE
  s text;
  old text;
  new text;
  changes jsonb;
  c record;
BEGIN
  SELECT pg_get_functiondef('public.fn_lightning_integrity_report(uuid,jsonb,timestamptz)'::regprocedure) INTO s;
  changes := jsonb_build_array(
    jsonb_build_array(
      $a$  c_tc_min_follow constant numeric := 0.5;$a$,
      $b$  c_tc_min_follow constant numeric := 0.5;
  c_tc_corr_lb_z  constant numeric := 2.326;$b$),
    jsonb_build_array(
      $a$  v_peak     integer;$a$,
      $b$  v_peak     integer;
  v_corr_lb  numeric;$b$),
    jsonb_build_array(
      $a$                       THEN LEAST(coalesce(a.fast_follows, 0) / a.sequential_actions, 1) END;$a$,
      $b$                       THEN LEAST(coalesce(a.fast_follows, 0) / a.sequential_actions, 1) END;
      -- The correlation scores by its one-sided 99% Fisher-z lower confidence
      -- bound over the measured paired hands, so a short sample cannot reach
      -- high on r alone. Detection still tests r itself.
      v_corr_lb := CASE WHEN v_corr IS NOT NULL AND a.corr_n > 3
        THEN round((tanh(atanh(LEAST(GREATEST(v_corr::double precision, -0.999999), 0.999999))
                         - c_tc_corr_lb_z::double precision / sqrt((a.corr_n - 3)::double precision)))::numeric, 4) END;$b$),
    jsonb_build_array(
      $a$'fast_follows', a.fast_follows, 'latency_corr', v_corr,$a$,
      $b$'fast_follows', a.fast_follows, 'latency_corr', v_corr, 'latency_corr_lower_bound_99', v_corr_lb,$b$),
    jsonb_build_array(
      $a$v_score := LEAST(100, round(40 + 50 * GREATEST(coalesce(v_corr, 0), coalesce(v_follow, 0))))::integer;$a$,
      $b$v_score := LEAST(100, round(40 + 50 * GREATEST(coalesce(v_corr_lb, 0), coalesce(v_follow, 0))))::integer;$b$),
    jsonb_build_array(
      $a$'timing_min_follow_share', c_tc_min_follow));$a$,
      $b$'timing_min_follow_share', c_tc_min_follow,
                              'timing_corr_score_method', 'fisher_z_one_sided_99_lower_bound',
                              'timing_corr_score_z', c_tc_corr_lb_z));$b$)
  );
  FOR c IN SELECT value FROM jsonb_array_elements(changes) LOOP
    old := c.value->>0; new := c.value->>1;
    IF (length(s)-length(replace(s,old,'')))/length(old) <> 1 THEN
      RAISE EXCEPTION 'Lightning correlation confidence source mismatch: %',left(old,80);
    END IF;
    s := replace(s,old,new);
  END LOOP;
  EXECUTE s;
END $patch$;
COMMIT;
