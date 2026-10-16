-- Isolated PostgreSQL fixture only. Existing platform doors build the pool.
CREATE OR REPLACE FUNCTION harness.moment_case(p_kind text) RETURNS jsonb
LANGUAGE plpgsql AS $f$
DECLARE
 g uuid; x uuid; y uuid; t timestamptz := date_trunc('minute',clock_timestamp())-interval '70 minutes';
 i integer; pair jsonb; win jsonb; r jsonb; before_rows bigint; after_rows bigint; signals integer;
BEGIN
 g := harness.lc('MOMENT-'||p_kind||'-'||gen_random_uuid()::text);
 x := (harness.idle(g,false,1))[1]; y := (harness.idle(g,true,1))[1];
 FOR i IN 0..9 LOOP
   pair := jsonb_build_object('player_a',x,'player_b',y,'hands_together',2,'sequential_actions',3,'fast_follows',0);
   IF p_kind='borrowed' AND i=0 THEN
     pair := pair||jsonb_build_object('hands_together',4,'sequential_actions',11,'latency_corr',0.9949,
       'corr_n',4,'corr_sx',10,'corr_sy',20,'corr_sxx',30,'corr_syy',120,'corr_sxy',60);
   ELSIF p_kind='positive' THEN
     -- Each window has only TWO paired samples and cannot emit Pearson r.
     -- Together they contain 20 genuinely paired, perfectly correlated hands.
     pair := pair||jsonb_build_object('corr_n',2,'corr_sx',3,'corr_sy',6,'corr_sxx',5,'corr_syy',20,'corr_sxy',10);
   ELSIF p_kind='negative' THEN
     pair := pair||jsonb_build_object('latency_corr',1,
       'corr_n',2,'corr_sx',3,'corr_sy',3,'corr_sxx',5,'corr_syy',5,'corr_sxy',4);
   ELSIF p_kind='fast_follow' THEN
     pair := pair||jsonb_build_object('fast_follows',2);
   END IF;
   win := harness.r_window(t+i*interval '5 minutes','[]'::jsonb,jsonb_build_array(pair));
   r := public.fn_lightning_integrity_report(g,win);
   IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Report refused: %',r; END IF;
 END LOOP;
 SELECT count(*) INTO before_rows FROM public.lightning_integrity_engine_window WHERE cluster_id=g;
 r := public.fn_lightning_integrity_report(g,win);
 SELECT count(*) INTO after_rows FROM public.lightning_integrity_engine_window WHERE cluster_id=g;
 IF before_rows<>after_rows THEN RAISE EXCEPTION 'Replayed window increased evidence'; END IF;
 SELECT count(*) INTO signals FROM public.lightning_integrity_signal WHERE cluster_id=g AND pattern_type='TIMING_CORRELATION';
 RETURN jsonb_build_object('signals',signals,'evidence_rows',after_rows,
   'correlation_hands',(SELECT evidence->'correlation_hands' FROM public.lightning_integrity_signal WHERE cluster_id=g AND pattern_type='TIMING_CORRELATION' LIMIT 1));
END $f$;
CREATE TEMP TABLE moment_results AS SELECT k,harness.moment_case(k) AS result
 FROM unnest(ARRAY['borrowed','positive','negative','fast_follow']) k;
TABLE moment_results;
DO $check$
DECLARE corrected boolean := position('pooled_paired_hand_moments' in pg_get_functiondef('public.fn_lightning_integrity_report(uuid,jsonb,timestamptz)'::regprocedure))>0;
BEGIN
 IF EXISTS(SELECT 1 FROM moment_results WHERE (result->>'signals')::int <>
    CASE WHEN k='fast_follow' THEN 1 WHEN corrected AND k='positive' THEN 1
         WHEN NOT corrected AND k IN ('borrowed','negative') THEN 1 ELSE 0 END) THEN
   RAISE EXCEPTION 'Correlation result does not match independent expected cases, corrected=%',corrected;
 END IF;
 IF corrected AND (SELECT result->>'correlation_hands' FROM moment_results WHERE k='positive') <> '20' THEN
   RAISE EXCEPTION 'Positive finding did not name its 20 actually paired samples';
 END IF;
END $check$;
