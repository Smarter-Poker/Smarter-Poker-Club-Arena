\set ON_ERROR_STOP on
-- Executed inside the maintained legacy certification transaction, before the
-- valid receipt is written. A legacy result may not claim a different schema.
CREATE FUNCTION public.v31_v4_consumer_probe(dataset uuid,kind text,family text,result_id bigint)
RETURNS void LANGUAGE plpgsql AS $probe$
DECLARE saved jsonb; variant jsonb; failed boolean; signature regprocedure;
BEGIN
 SELECT config_a INTO saved FROM public.horse_league_results WHERE id=result_id;
 FOREACH variant IN ARRAY ARRAY['null'::jsonb,'"unknown"'::jsonb,'"smarter-poker.pio-policy.v4"'::jsonb] LOOP
  UPDATE public.horse_league_results SET config_a=saved||jsonb_build_object('policy_export_schema',variant) WHERE id=result_id;
  failed:=false;
  BEGIN PERFORM public.fn_gto_v31_record_evaluation(dataset,kind,family,result_id);
  EXCEPTION WHEN OTHERS THEN failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'evaluation accepted invalid or mismatched policy schema'; END IF;
 END LOOP;
 UPDATE public.horse_league_results SET config_a=saved WHERE id=result_id;
 FOREACH signature IN ARRAY ARRAY['public.fn_gto_v31_active_cells(integer,integer)'::regprocedure,
 'public.fn_gto_v31_evaluation_cells(uuid,integer,integer)'::regprocedure] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=signature
   AND proargnames[array_length(proargnames,1)]='policy_export_schema'
   AND strpos(prosrc,'b.policy_export_schema IS NOT DISTINCT FROM d.policy_export_schema')>0
   AND strpos(prosrc,'c.policy_export_schema IS NOT DISTINCT FROM d.policy_export_schema')>0) THEN
   RAISE EXCEPTION 'RPC dropped policy identity or bundle/cell binding'; END IF;
 END LOOP;
 IF NOT public.fn_gto_v31_policy_request_valid('{"policy_export_schema":"smarter-poker.pio-policy.v4"}'::jsonb) THEN
  RAISE EXCEPTION 'explicit known V4 identity rejected'; END IF;
 RAISE NOTICE 'V31_V4_CONSUMER_BOUNDARY_OK';
END;
$probe$;
