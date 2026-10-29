-- Pure public boundary/physics fixture; no licensed records, models or holdout.
DO $check$
DECLARE w numeric[]:=array_fill(1::numeric,ARRAY[1326]);v jsonb;r integer;
BEGIN
 -- Royal spade board ties every legal own/opponent hand.
 v:=public.fn_gto_v31_public215_wtl(ARRAY[0,5],ARRAY[35,39,43,47,51],w);
 IF v->'current'<>jsonb_build_array('0','990','0','990') OR v->'terminal'<>v->'current' OR (v->>'terminalRunouts')::integer<>1 THEN RAISE EXCEPTION 'public215 independent royal-board tie oracle';END IF;
 IF public.fn_gto_v31_public215_rank(ARRAY[35,39,43,47,51,0,5])<>8*15^5+14*15^4 THEN RAISE EXCEPTION 'public215 independent royal rank';END IF;
 BEGIN PERFORM public.fn_gto_v31_public215_wtl(ARRAY[0,0],ARRAY[35,39,43],w);RAISE EXCEPTION 'accepted duplicate';EXCEPTION WHEN OTHERS THEN IF SQLERRM='accepted duplicate' THEN RAISE;END IF;END;
 BEGIN PERFORM public.fn_gto_v31_public215_wtl(ARRAY[0,5],ARRAY[35,39,43],array_fill(0::numeric,ARRAY[1326]));RAISE EXCEPTION 'accepted zero';EXCEPTION WHEN OTHERS THEN IF SQLERRM='accepted zero' THEN RAISE;END IF;END;
END $check$;
SELECT 'PUBLIC215_SYNTHETIC_BOUNDARIES_PASS' AS result;
