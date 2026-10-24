-- The original chain above retains its historical P0/P2/P3/P4/P5 and source-bound
-- calibration checks. Re-evaluate its independently captured immutable inputs
-- under the exact current owner policy before comparing with today's TS port.
-- This is a fresh qualification; historical calibration rows are not restamped.
DO $current$
DECLARE f record; g uuid; binding_before text; old_config jsonb; result jsonb; members jsonb;
BEGIN
 FOR f IN SELECT * FROM pp.out ORDER BY n LOOP
  g:=(f.doc#>>'{config,cluster_id}')::uuid;
  old_config:=f.doc->'config';
  result:=public.fn_lightning_match(g,to_timestamp((f.doc->>'now_us')::numeric/1000000),NULL,NULL,NULL);
  IF result->>'legal_count' IS DISTINCT FROM f.doc#>>'{plan,legal_count}' THEN
   RAISE EXCEPTION 'Current policy changed historical legality input: %',f.name;
  END IF;
  IF jsonb_array_length(result->'groups')=0 THEN RAISE EXCEPTION 'Current policy parity became vacuous: %',f.name; END IF;
  FOR members IN SELECT x FROM jsonb_array_elements(result->'groups') x LOOP
   IF jsonb_array_length(members->'players') NOT BETWEEN 5 AND 6 THEN RAISE EXCEPTION 'Current policy group outside5/6: % %',f.name,members; END IF;
  END LOOP;
  UPDATE pp.out SET doc=jsonb_set(jsonb_set(doc,'{config}',public.fn_lightning_config(g)),'{plan}',result) WHERE n=f.n;
 END LOOP;
END $current$;
\echo '  ok  12 CURRENT POLICY  exact source-admitted 20261023230001; independent fairness snapshots re-evaluated with unchanged legality and only five/six-player groups'
