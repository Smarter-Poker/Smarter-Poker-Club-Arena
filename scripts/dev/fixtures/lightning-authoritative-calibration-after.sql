DO $$
DECLARE g uuid; t timestamptz; i int; r jsonb; pair jsonb; binding text; changed text; cfg jsonb;
BEGIN
 SELECT game,t0 INTO g,t FROM pp.aa_case;
 IF jsonb_array_length(public.fn_lightning_shadow_report(g,t-interval '1 minute',clock_timestamp())->'version_pairs')<>0 THEN
   RAISE EXCEPTION 'Old unbound rows still supply current calibration'; END IF;
 binding:=public.fn_lightning_matcher_binding(g);
 FOR i IN 30..59 LOOP
   r:=public.fn_lightning_shadow_record(g,'m1','m1-port',t+i*interval '1 minute',t+(i+1)*interval '1 minute',pp.aa_metrics(binding),pp.aa_metrics(binding));
   IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Bound record refused: %',r; END IF;
   IF i=58 THEN
     pair:=public.fn_lightning_shadow_report(g,t,clock_timestamp())->'version_pairs'->0;
     IF pair->>'verdict' IS DISTINCT FROM 'insufficient_evidence' OR (pair->>'comparisons')::int<>29 THEN
       RAISE EXCEPTION 'The exact 30-comparison floor moved: %',pair; END IF;
   END IF;
 END LOOP;
 -- Stale hashes and empty windows remain stored but cannot qualify.
 PERFORM public.fn_lightning_shadow_record(g,'m1','m1-port',t+interval '61 minutes',t+interval '62 minutes',pp.aa_metrics(repeat('a',32)),pp.aa_metrics(repeat('a',32)));
 PERFORM public.fn_lightning_shadow_record(g,'m1','m1-port',t+interval '63 minutes',t+interval '64 minutes',pp.aa_metrics(binding,0),pp.aa_metrics(binding,0));
 pair:=public.fn_lightning_shadow_report(g,t,clock_timestamp())->'version_pairs'->0;
 IF pair->>'verdict' IS DISTINCT FROM 'calibrated' OR (pair->>'comparisons')::int<>30 THEN
   RAISE EXCEPTION 'Bound evidence or exclusion incorrect: %',pair; END IF;
 IF (SELECT count(*) FROM public.lightning_matcher_shadow_comparison WHERE cluster_id=g)<>62 THEN
   RAISE EXCEPTION 'Historical evidence was removed or invented'; END IF;
 -- Configuration changes are fixture boundaries, never a production door.
 SELECT ruleset_snapshot INTO cfg FROM public.cash_games WHERE id=g;
 UPDATE public.cash_games SET ruleset_snapshot=jsonb_set(cfg,'{lightning,worker_mode}','"shadow"') WHERE id=g;
 IF public.fn_lightning_matcher_binding(g)<>binding THEN RAISE EXCEPTION 'Worker mode invalidated unchanged matcher calibration'; END IF;
 UPDATE public.cash_games SET ruleset_snapshot=jsonb_set(cfg,'{lightning,instance_target}','4') WHERE id=g;
 changed:=public.fn_lightning_matcher_binding(g);
 IF changed=binding OR jsonb_array_length(public.fn_lightning_shadow_report(g,t,clock_timestamp())->'version_pairs')<>0 THEN
   RAISE EXCEPTION 'Changed matcher parameters reused old calibration'; END IF;
 UPDATE public.cash_games SET ruleset_snapshot=cfg WHERE id=g;
 IF has_function_privilege('anon','public.fn_lightning_matcher_snapshot(uuid,timestamptz,uuid[],jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','public.fn_lightning_matcher_snapshot(uuid,timestamptz,uuid[],jsonb)','EXECUTE') THEN
   RAISE EXCEPTION 'Matcher snapshot exposed to a browser'; END IF;
END $$;
-- Re-read the exact wrapper at each independently captured fixture timestamp.
-- None of these Clusters was mutated after its capture; inputs remain pinned.
UPDATE pp.out SET doc=jsonb_set(doc,'{plan}',public.fn_lightning_match(
 (doc#>>'{config,cluster_id}')::uuid,to_timestamp((doc->>'now_us')::numeric/1000000),NULL,NULL,NULL));
\echo '  ok  11B AUTHORITATIVE CALIBRATION  legacy, stale and empty rows excluded; 29 is insufficient, 30 qualifies; source/parameter binding and service-only authority'
