-- Isolated PostgreSQL fixture only. Existing platform doors build the pool.
-- TIMING_CORRELATION scores by the one-sided 99% Fisher-z lower bound of r
-- (20261022042102). Runs on the installed bodies before and after the file:
-- before, the short n=26 r=.7107 sample (finding 159's shape) is HIGH; after,
-- it is MEDIUM while detection, the strong long sample and follow share are
-- unchanged. Moments are built so pooled Pearson r is exactly the given r:
-- means 2 s and 3 s, unit variances, covariance r.
CREATE OR REPLACE FUNCTION harness.confidence_case(p_n integer, p_r numeric, p_seq integer, p_ff integer)
RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
 g uuid; x uuid; y uuid; t timestamptz := date_trunc('minute',clock_timestamp())-interval '30 minutes';
 pair jsonb; r jsonb; sig record;
BEGIN
 g := harness.lc('CONFIDENCE-'||p_n||'-'||p_r||'-'||gen_random_uuid()::text);
 x := (harness.idle(g,false,1))[1]; y := (harness.idle(g,true,1))[1];
 pair := jsonb_build_object('player_a',x,'player_b',y,'hands_together',p_n,'sequential_actions',p_seq,
   'fast_follows',p_ff,'corr_n',p_n,'corr_sx',2*p_n,'corr_sy',3*p_n,'corr_sxx',5*p_n,'corr_syy',10*p_n,
   'corr_sxy',p_n*(6+p_r));
 r := public.fn_lightning_integrity_report(g,harness.r_window(t,'[]'::jsonb,jsonb_build_array(pair)));
 IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Report refused: %',r; END IF;
 SELECT count(*) OVER () AS signals, s.suspicion_score, s.severity, s.evidence INTO sig
   FROM public.lightning_integrity_signal s WHERE s.cluster_id=g AND s.pattern_type='TIMING_CORRELATION';
 RETURN jsonb_build_object('signals',coalesce(sig.signals,0),'score',sig.suspicion_score,'severity',sig.severity,
   'r',sig.evidence->'latency_corr','r_lb',sig.evidence->'latency_corr_lower_bound_99',
   'flagged',r->'flagged'->'TIMING_CORRELATION','thresholds',r->'thresholds');
END $f$;
CREATE TEMP TABLE confidence_results AS
SELECT k, harness.confidence_case(n, rr, seq, ff) AS result
  FROM (VALUES ('short_n26_r711', 26, 0.7107, 40, 0),
               ('strong_n80_r85', 80, 0.85, 120, 0),
               ('follow_share_60', 26, 0.2, 40, 24),
               ('below_trigger_r65', 26, 0.65, 40, 5)) v(k, n, rr, seq, ff);
SELECT k, result - 'thresholds' AS result FROM confidence_results ORDER BY k;
DO $check$
DECLARE
 bounded boolean := position('latency_corr_lower_bound_99' in pg_get_functiondef('public.fn_lightning_integrity_report(uuid,jsonb,timestamptz)'::regprocedure))>0;
 j jsonb;
BEGIN
 -- (a) the short sample: detected either way; high before, medium after.
 SELECT result INTO j FROM confidence_results WHERE k='short_n26_r711';
 IF (j->>'signals')::int <> 1 OR (j->>'r')::numeric <> 0.7107 THEN
   RAISE EXCEPTION 'FAIL confidence (a): n26 r.7107 must still be detected: %', j;
 END IF;
 IF NOT bounded AND (j->>'score' <> '76' OR j->>'severity' <> 'high') THEN
   RAISE EXCEPTION 'FAIL confidence (a): the defect was not reproduced on the installed body: %', j;
 END IF;
 IF bounded AND (j->>'score' <> '59' OR j->>'severity' <> 'medium'
                 OR abs((j->>'r_lb')::numeric - 0.3830) > 0.0005) THEN
   RAISE EXCEPTION 'FAIL confidence (a): n26 r.7107 must score 59 medium on r_lb 0.383: %', j;
 END IF;
 -- (b) a strong long sample stays high.
 SELECT result INTO j FROM confidence_results WHERE k='strong_n80_r85';
 IF (j->>'signals')::int <> 1 OR j->>'severity' <> 'high'
    OR j->>'score' <> (CASE WHEN bounded THEN '78' ELSE '83' END)
    OR (bounded AND abs((j->>'r_lb')::numeric - 0.7578) > 0.0005) THEN
   RAISE EXCEPTION 'FAIL confidence (b): n80 r.85 must remain high: %', j;
 END IF;
 -- (c) follow share scores exactly as before: 40 + 50 * 0.6 = 70, high.
 SELECT result INTO j FROM confidence_results WHERE k='follow_share_60';
 IF (j->>'signals')::int <> 1 OR j->>'score' <> '70' OR j->>'severity' <> 'high' THEN
   RAISE EXCEPTION 'FAIL confidence (c): follow-share scoring changed: %', j;
 END IF;
 -- (d) the trigger is unchanged: r .65 with follow share .125 raises nothing.
 SELECT result INTO j FROM confidence_results WHERE k='below_trigger_r65';
 IF (j->>'signals')::int <> 0 OR (j->>'flagged')::int <> 0 THEN
   RAISE EXCEPTION 'FAIL confidence (d): a sub-threshold pair was flagged: %', j;
 END IF;
 -- The returned thresholds name the scoring method after the file, and the
 -- detection thresholds are the same numbers either way.
 SELECT result->'thresholds' INTO j FROM confidence_results WHERE k='short_n26_r711';
 IF j->>'timing_min_hands' <> '20' OR j->>'timing_min_sequential' <> '30' OR j->>'timing_min_corr' <> '0.7'
    OR j->>'timing_min_follow_share' <> '0.5' THEN
   RAISE EXCEPTION 'FAIL confidence: detection thresholds changed: %', j;
 END IF;
 IF bounded AND (j->>'timing_corr_score_method' IS DISTINCT FROM 'fisher_z_one_sided_99_lower_bound'
                 OR j->>'timing_corr_score_z' IS DISTINCT FROM '2.326') THEN
   RAISE EXCEPTION 'FAIL confidence: thresholds do not name the scoring method: %', j;
 END IF;
 RAISE NOTICE 'confidence witnesses passed, bounded=%', bounded;
END $check$;
\echo '  confidence witnesses passed'
