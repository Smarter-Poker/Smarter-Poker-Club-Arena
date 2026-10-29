-- Actual public input cohort MAXA3/H7. Synthetic worst29node/depth14 numeric trees.
DO $cost$
DECLARE tree jsonb:='[]';trees jsonb;head jsonb;heads jsonb;model jsonb;compiled public.gto_v31_public215_head[];i integer;raw double precision[];start_at timestamptz;compile_ms numeric;infer_ms numeric;
BEGIN
 FOR i IN 0..13 LOOP tree:=tree||jsonb_build_array(jsonb_build_object('feature',i,'threshold_f64','0000000000000000','left',CASE WHEN i<13 THEN i+1 ELSE 27 END,'right',CASE WHEN i<13 THEN 14+i ELSE 28 END,'missing_left',false));END LOOP;
 FOR i IN 14..28 LOOP tree:=tree||jsonb_build_array(jsonb_build_object('value_f64','0000000000000000'));END LOOP;
 SELECT jsonb_agg(tree) INTO trees FROM generate_series(1,100);head:=jsonb_build_object('baseline_f64','3ff0000000000000','trees',trees);SELECT jsonb_agg(head) INTO heads FROM generate_series(1,7);
 model:=jsonb_build_object('format','public_hist215_v1','variant','coherent','feature_count',215,'action_ids',jsonb_build_array('c','b250','b8000'),'heads',heads,'template_sha256',repeat('a',64),'feature_schema_sha256',repeat('b',64),'provenance_sha256',repeat('c',64));
 start_at:=clock_timestamp();compiled:=public.fn_gto_v31_public215_compile(model);compile_ms:=extract(epoch FROM clock_timestamp()-start_at)*1000;
 start_at:=clock_timestamp();FOR i IN 1..1176 LOOP raw:=public.fn_gto_v31_public215_compiled_raw(compiled,array_fill(0::double precision,ARRAY[215]));IF raw<>array_fill(1::double precision,ARRAY[7]) THEN RAISE EXCEPTION 'compiled head oracle mismatch';END IF;END LOOP;infer_ms:=extract(epoch FROM clock_timestamp()-start_at)*1000;
 RAISE NOTICE 'PUBLIC215_H7_100TREES_29NODES_1176COMBOS compile_ms=% inference_ms=% bytes=%',compile_ms,infer_ms,octet_length(public.fn_gto_v31_public215_canonical(model));
END $cost$;
