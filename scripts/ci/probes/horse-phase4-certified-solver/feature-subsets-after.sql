\set ON_ERROR_STOP on
DO $equivalence$
DECLARE expected record; actual record; mismatches integer; started timestamptz;
 old_ms double precision; new_ms double precision;
BEGIN
 SELECT * INTO STRICT expected FROM v31_feature_metadata_before;
 SELECT * INTO STRICT actual FROM pg_proc WHERE oid=expected.oid;
 IF actual.proowner<>expected.proowner OR actual.proacl IS DISTINCT FROM expected.proacl
 OR actual.proconfig IS DISTINCT FROM expected.proconfig OR actual.proisstrict<>expected.proisstrict
 OR actual.provolatile<>expected.provolatile OR actual.prosecdef<>expected.prosecdef
 OR actual.proparallel<>expected.proparallel OR actual.prorettype<>expected.prorettype
 OR actual.proargtypes<>expected.proargtypes OR actual.proleakproof<>expected.proleakproof
 THEN RAISE EXCEPTION 'V31 feature optimization changed metadata'; END IF;
 IF EXISTS(SELECT 1 FROM v31_feature_callers_before b
  WHERE pg_get_functiondef(b.oid) IS DISTINCT FROM b.definition)
 THEN RAISE EXCEPTION 'V31 feature optimization changed build, seal, heldout or promotion'; END IF;
 started:=clock_timestamp();
 SELECT count(*) INTO mismatches FROM v31_feature_equivalence_cases
 WHERE public.fn_gto_v31_board_relative_key_v2(combo,board) IS DISTINCT FROM old_key;
 new_ms:=extract(epoch FROM clock_timestamp()-started)*1000;
 INSERT INTO v31_feature_timings VALUES('new',new_ms);
 IF mismatches<>0 OR (SELECT count(*) FROM v31_feature_equivalence_cases)<>21216
 THEN RAISE EXCEPTION 'V31 feature wire differs on % cases',mismatches; END IF;
 IF public.fn_gto_v31_board_relative_key_v2(-1,'KsQdJc') IS NOT NULL
 OR public.fn_gto_v31_board_relative_key_v2(1326,'KsQdJc') IS NOT NULL
 OR public.fn_gto_v31_board_relative_key_v2(0,'KsKsJc') IS NOT NULL
 OR public.fn_gto_v31_board_relative_key_v2(0,'KsQd') IS NOT NULL
 OR public.fn_gto_v31_board_relative_key_v2(0,'ksQdJc') IS NOT NULL
 OR public.fn_gto_v31_board_relative_key_v2(NULL,'KsQdJc') IS NOT NULL
 OR public.fn_gto_v31_board_relative_key_v2(0,NULL) IS NOT NULL
 THEN RAISE EXCEPTION 'V31 feature malformed/null input admission changed'; END IF;
 SELECT elapsed_ms INTO STRICT old_ms FROM v31_feature_timings WHERE kind='old';
 IF new_ms>=old_ms THEN RAISE EXCEPTION 'V31 feature optimization did not reduce measured subset work: old %, new % ms',old_ms,new_ms; END IF;
 RAISE NOTICE 'V31_FEATURE_SUBSET_EQUIVALENCE_OK: 21216 exact cases; old % ms, new % ms, speedup %',
  round(old_ms::numeric,2),round(new_ms::numeric,2),round((old_ms/new_ms)::numeric,2);
END;
$equivalence$;
SELECT 'V31_FEATURE_SUBSET_EQUIVALENCE_OK';
