-- Strict numeric-only model contract fixture. Synthetic100 constant trees/head.
DO $test$
DECLARE words text[]:=ARRAY['0000000000000000','8000000000000000','0000000000000001','000fffffffffffff','0010000000000000','3ff0000000000000','bff0000000000000','7fefffffffffffff'];h text;v double precision;t jsonb;head jsonb;model jsonb;bad jsonb;n integer;
BEGIN
 FOREACH h IN ARRAY words LOOP v:=public.fn_gto_v31_public215_f64(h);IF encode(float8send(v),'hex')<>h THEN RAISE EXCEPTION 'f64 word parity %',h;END IF;END LOOP;
 FOREACH n IN ARRAY ARRAY[2,3,8,16]LOOP IF encode(float8send(public.fn_gto_v31_public215_action_sum(array_fill('-0'::double precision,ARRAY[n]))),'hex')<>'0000000000000000'THEN RAISE EXCEPTION 'np.sum positive-zero identity boundary %',n;END IF;END LOOP;
 BEGIN PERFORM public.fn_gto_v31_public215_f64('7ff0000000000000');RAISE EXCEPTION 'accepted infinity';EXCEPTION WHEN OTHERS THEN IF SQLERRM='accepted infinity' THEN RAISE;END IF;END;
 SELECT jsonb_agg(jsonb_build_array(jsonb_build_object('value_f64','0000000000000000')) ORDER BY i) INTO t FROM generate_series(1,100)i;
 head:=jsonb_build_object('baseline_f64','3ff0000000000000','trees',t);
 model:=jsonb_build_object('format','public_hist215_v1','variant','direct','feature_count',215,'action_ids',jsonb_build_array('c'),'heads',jsonb_build_array(head,head,head),'template_sha256',repeat('a',64),'feature_schema_sha256',repeat('b',64),'provenance_sha256',repeat('c',64));
 IF NOT public.fn_gto_v31_public215_model_valid(model) THEN RAISE EXCEPTION 'valid synthetic100model rejected';END IF;
 IF public.fn_gto_v31_public215_infer(model,array_fill(0::double precision,ARRAY[215]))<>jsonb_build_object('policyEvBb',1,'actionEvsBb',jsonb_build_object('c',1),'mix',jsonb_build_object('c',1)) THEN RAISE EXCEPTION 'independent model constant oracle';END IF;
 IF encode(float8send(public.fn_gto_v31_public215_ratio(1,3)),'hex')<>'3fd5555555555555' OR encode(float8send(public.fn_gto_v31_public215_ratio(1,10)),'hex')<>'3fb999999999999a' THEN RAISE EXCEPTION 'ratio roundnearest-even oracle';END IF;
 bad:=jsonb_set(model,'{heads,0,baseline_f64}','null');IF public.fn_gto_v31_public215_model_valid(bad) THEN RAISE EXCEPTION 'null baseline accepted';END IF;
 bad:=jsonb_set(model,'{format}','null');IF public.fn_gto_v31_public215_model_valid(bad) THEN RAISE EXCEPTION 'null format accepted';END IF;
 bad:=jsonb_set(model,'{heads,0,trees,0}',jsonb_build_array(jsonb_build_object('feature',0,'threshold_f64','0000000000000000','left',0,'right',1,'missing_left',false),jsonb_build_object('value_f64','0000000000000000'),jsonb_build_object('value_f64','0000000000000000')));IF public.fn_gto_v31_public215_model_valid(bad) THEN RAISE EXCEPTION 'cycle/unreachable accepted';END IF;
 bad:=jsonb_set(model,'{heads,0,trees}',t-99);IF public.fn_gto_v31_public215_model_valid(bad) THEN RAISE EXCEPTION '99trees accepted';END IF;
END $test$;
SELECT 'PUBLIC215_F64_AND_MODEL_GUARDS_PASS' AS result;
