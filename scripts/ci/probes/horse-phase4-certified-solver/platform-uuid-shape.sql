\set ON_ERROR_STOP on
DO $probe$ DECLARE r record; shape text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; BEGIN
 IF NOT '00000000-0000-0000-0000-000000000062' ~ shape
 OR NOT 'ffffffff-ffff-ffff-ffff-ffffffffffff' ~ shape
 OR '00000000-0000-0000-0000-00000000006Z' ~ shape THEN RAISE EXCEPTION 'UUID shape boundary differs'; END IF;
 FOR r IN SELECT oid,pg_get_functiondef(oid) def FROM pg_proc WHERE oid IN
 ('public.fn_gto_v31_register_dataset(jsonb)'::regprocedure,'public.fn_horse_solver_agreement_v31_decision(jsonb)'::regprocedure) LOOP
 IF strpos(r.def,'[1-'||'5]')>0 OR strpos(r.def,shape)=0 THEN RAISE EXCEPTION 'live platform UUID predicate is not shape-only'; END IF;
 END LOOP;
 IF has_function_privilege('anon','public.fn_gto_v31_register_dataset(jsonb)','execute')
 OR has_function_privilege('authenticated','public.fn_horse_solver_agreement_v31_decision(jsonb)','execute')
 OR has_function_privilege('service_role','public.fn_horse_solver_agreement_v31_decision(jsonb)','execute') THEN RAISE EXCEPTION 'platform validator privileges changed'; END IF;
END; $probe$;
SELECT 'V31_PLATFORM_UUID_SHAPE_OK' AS result;
