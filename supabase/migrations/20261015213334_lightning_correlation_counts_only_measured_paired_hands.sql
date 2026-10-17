-- 20261015213334_lightning_correlation_counts_only_measured_paired_hands.sql
-- Private-pilot finding: 0.9949 from four shared hands was tested against
-- counts including other windows without a correlation measurement. Pool the
-- actual paired-hand moments instead; leave findings open for operator review.
-- Install before the containing engine; old reports retain fast-follow
-- detection but do not establish a measured paired correlation sample.
-- @live-proof: (SELECT s LIKE '%pooled_paired_hand_moments%' AND s LIKE '%a.corr_n >= c_tc_min_hands%' AND s LIKE '%corr_sxy%' AND s NOT LIKE '%AS corr_w%' AND p.prosecdef AND has_function_privilege('service_role',p.oid,'EXECUTE') AND NOT has_function_privilege('anon',p.oid,'EXECUTE') FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE p.oid='public.fn_lightning_integrity_report(uuid,jsonb,timestamptz)'::regprocedure)
-- Pool additive paired-hand moments, never per-window Pearson coefficients.
-- Legacy window counts cannot lend sample size to a short measured window.
-- Existing findings and all money/seat/session rows are untouched.
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
      $a$ELSE ARRAY['hands_together', 'sequential_actions', 'fast_follows', 'latency_corr'] END LOOP$a$,
      $b$ELSE ARRAY['hands_together', 'sequential_actions', 'fast_follows', 'latency_corr', 'corr_n', 'corr_sx', 'corr_sy', 'corr_sxx', 'corr_syy', 'corr_sxy'] END LOOP$b$),
    jsonb_build_array(
      $a$(ew.numbers ->> 'fast_follows')::numeric AS ff, (ew.numbers ->> 'latency_corr')::numeric AS cr$a$,
      $b$(ew.numbers ->> 'fast_follows')::numeric AS ff, (ew.numbers ->> 'latency_corr')::numeric AS cr,
             CASE WHEN ew.numbers ?& ARRAY['corr_n','corr_sx','corr_sy','corr_sxx','corr_syy','corr_sxy']
                       AND (ew.numbers ->> 'corr_n')::numeric > 0
                  THEN (ew.numbers ->> 'corr_n')::numeric END AS cn,
             (ew.numbers ->> 'corr_sx')::numeric AS csx, (ew.numbers ->> 'corr_sy')::numeric AS csy,
             (ew.numbers ->> 'corr_sxx')::numeric AS csxx, (ew.numbers ->> 'corr_syy')::numeric AS csyy,
             (ew.numbers ->> 'corr_sxy')::numeric AS csxy$b$),
    jsonb_build_array(
      $a$sum(ev.seq * ev.cr) / nullif(sum(ev.seq) FILTER (WHERE ev.cr IS NOT NULL), 0) AS corr_w,
           avg(ev.cr) AS corr_u$a$,
      $b$sum(ev.cn) AS corr_n,
           sum(ev.csx) FILTER (WHERE ev.cn IS NOT NULL) AS corr_sx,
           sum(ev.csy) FILTER (WHERE ev.cn IS NOT NULL) AS corr_sy,
           sum(ev.csxx) FILTER (WHERE ev.cn IS NOT NULL) AS corr_sxx,
           sum(ev.csyy) FILTER (WHERE ev.cn IS NOT NULL) AS corr_syy,
           sum(ev.csxy) FILTER (WHERE ev.cn IS NOT NULL) AS corr_sxy$b$),
    jsonb_build_array(
      $a$v_corr := round(coalesce(a.corr_w, a.corr_u), 4);$a$,
      $b$-- Only paired completed hands can satisfy the correlation sample floor.
      -- Seconds-based additive moments preserve within- and between-window
      -- covariance. Legacy coefficients are retained as evidence, not pooled.
      v_corr := CASE WHEN a.corr_n >= c_tc_min_hands
                          AND a.corr_n*a.corr_sxx-a.corr_sx*a.corr_sx > 0
                          AND a.corr_n*a.corr_syy-a.corr_sy*a.corr_sy > 0
        THEN round(GREATEST(-1,LEAST(1,
          (a.corr_n*a.corr_sxy-a.corr_sx*a.corr_sy) /
          sqrt((a.corr_n*a.corr_sxx-a.corr_sx*a.corr_sx) *
               (a.corr_n*a.corr_syy-a.corr_sy*a.corr_sy)))),4) END;$b$),
    jsonb_build_array(
      $a$'fast_follows', a.fast_follows, 'latency_corr', v_corr, 'follow_share', round(v_follow, 4)$a$,
      $b$'fast_follows', a.fast_follows, 'latency_corr', v_corr,
                 'correlation_hands', coalesce(a.corr_n,0), 'correlation_method', 'pooled_paired_hand_moments',
                 'follow_share', round(v_follow, 4)$b$)
  );
  FOR c IN SELECT value FROM jsonb_array_elements(changes) LOOP
    old := c.value->>0; new := c.value->>1;
    IF (length(s)-length(replace(s,old,'')))/length(old) <> 1 THEN
      RAISE EXCEPTION 'Lightning correlation source mismatch: %',left(old,80);
    END IF;
    s := replace(s,old,new);
  END LOOP;
  EXECUTE s;
END $patch$;
COMMIT;
