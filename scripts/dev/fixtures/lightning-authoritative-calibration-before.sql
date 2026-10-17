CREATE TABLE pp.aa_case (game uuid, t0 timestamptz);
CREATE FUNCTION pp.aa_metrics(binding text DEFAULT NULL, seated integer DEFAULT 6) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
 SELECT jsonb_build_object('passes',1,'quorum_passes',1,'groups',1,'seated',seated,
   'formation_success_rate',1,'failure_rate',0,'wait_ms',jsonb_build_object('n',6,'p50',100,'p95',100),
   'opponent_diversity',jsonb_build_object('repeat_pair_rate',0),
   'instance_occupancy',jsonb_build_object('utilization',1),'snapshot_binding',binding);
$f$;
DO $$
DECLARE g uuid; t timestamptz:=date_trunc('minute',clock_timestamp())-interval '2 hours'; i int; r jsonb; pair jsonb;
BEGIN
 g:=pp.cluster('AUTHORITATIVE-AA',6,18,0);
 INSERT INTO pp.aa_case VALUES(g,t);
 FOR i IN 0..29 LOOP
   r:=public.fn_lightning_shadow_record(g,'m1','m1-port',t+i*interval '1 minute',t+(i+1)*interval '1 minute',pp.aa_metrics(),pp.aa_metrics());
   IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Baseline record refused: %',r; END IF;
 END LOOP;
 pair:=public.fn_lightning_shadow_report(g,t-interval '1 minute',clock_timestamp())->'version_pairs'->0;
 IF pair->>'verdict' IS DISTINCT FROM 'calibrated' OR (pair->>'comparisons')::int<>30 THEN
   RAISE EXCEPTION 'Unbound baseline calibration did not reproduce: %',pair;
 END IF;
END $$;
\echo '  ok  11A REPRODUCED  thirty unbound historical comparisons certify calibration on the old report'
