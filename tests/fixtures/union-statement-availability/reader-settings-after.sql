DO $test$
DECLARE p record; before_setting text:=current_setting('enable_indexscan');
BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid='public.fn_ca_bomb_pot_catchup(uuid,integer)'::regprocedure;
 IF md5(p.prosrc)<>'18e6c2541c8d13062478fe22b4670147' OR NOT ('enable_indexscan=off'=ANY(p.proconfig))
 OR NOT p.prosecdef OR NOT ('search_path=public'=ANY(p.proconfig))
 THEN RAISE EXCEPTION 'Bomb source, security or bounded bitmap plan changed'; END IF;
 IF has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('anon',p.oid,'EXECUTE')
 OR NOT has_function_privilege('service_role',p.oid,'EXECUTE') THEN RAISE EXCEPTION 'Bomb private authority changed'; END IF;
 PERFORM public.fn_ca_bomb_pot_catchup('11111111-1111-4111-8111-111111111111',1);
 IF current_setting('enable_indexscan')<>before_setting THEN RAISE EXCEPTION 'Bomb plan setting escaped its call'; END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='public.ca_rake_snapshot(text,uuid,uuid,date,date,uuid,integer,integer,text,text)'::regprocedure;
 IF md5(p.prosrc)<>'59e6f3ea0f8529de6d64971a90c8f470' OR NOT ('statement_timeout=20s'=ANY(p.proconfig))
 OR NOT ('work_mem=64MB'=ANY(p.proconfig)) OR NOT ('search_path=public'=ANY(p.proconfig)) OR NOT p.prosecdef
 THEN RAISE EXCEPTION 'Snapshot calculations, security or bounded read settings changed'; END IF;
 IF has_function_privilege('anon',p.oid,'EXECUTE') OR NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
 THEN RAISE EXCEPTION 'Snapshot caller authority changed'; END IF;
 RAISE NOTICE 'PASS: exact report bodies and caller authority preserved; plan/read settings scoped and bounded';
END $test$;
