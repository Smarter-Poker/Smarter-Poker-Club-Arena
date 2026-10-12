-- Each retained hand previously issued its own card UPDATE and fired three
-- statement-level rollup calculations. Keep all original per-hand authority,
-- certificates and advisory locks; execute the card-only transition once.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $patch$
DECLARE target oid:='smarter_private.compact_horse_fact_cards(uuid[])'::regprocedure;
 source text; metadata jsonb; actual jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig)
 INTO source,metadata FROM pg_proc WHERE oid=target;
 IF md5(source) IS DISTINCT FROM '253d99c2802c37de7170e98e38ed0a5c' THEN
  RAISE EXCEPTION 'HORSE_FACT_BATCH_SOURCE_CHANGED_OR_ALREADY_INSTALLED' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole
  AND proacl::text='{postgres=X/postgres}' AND prosecdef=true
  AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN
  RAISE EXCEPTION 'HORSE_FACT_BATCH_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
 IF (length(source)-length(replace(source,'  UPDATE public.ca_hand_facts f SET hole_cards=NULL WHERE f.hand_id=id AND f.hole_cards IS NOT NULL;
  GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;','')))/length('  UPDATE public.ca_hand_facts f SET hole_cards=NULL WHERE f.hand_id=id AND f.hole_cards IS NOT NULL;
  GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;')<>1 THEN
  RAISE EXCEPTION 'HORSE_FACT_BATCH_UPDATE_ANCHOR_CHANGED' USING ERRCODE='55000'; END IF;
 source:=replace(source,'total integer:=0;','total integer:=0; qualified uuid[]:=ARRAY[]::uuid[];');
 source:=replace(source,'  UPDATE public.ca_hand_facts f SET hole_cards=NULL WHERE f.hand_id=id AND f.hole_cards IS NOT NULL;
  GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;','  qualified:=array_append(qualified,id);');
 source:=replace(source,' RETURN total;',' IF cardinality(qualified)>0 THEN
  UPDATE public.ca_hand_facts f SET hole_cards=NULL WHERE f.hand_id=ANY(qualified) AND f.hole_cards IS NOT NULL;
  GET DIAGNOSTICS total=ROW_COUNT;
 END IF;
 RETURN total;');
 EXECUTE source;
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig)
 INTO actual FROM pg_proc WHERE oid=target;
 IF actual IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'HORSE_FACT_BATCH_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
END $patch$;
COMMIT;
