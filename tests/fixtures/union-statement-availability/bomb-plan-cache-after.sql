DO $test$
DECLARE p record; before_mode text:=current_setting('plan_cache_mode');
BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid='public.fn_ca_bomb_pot_catchup(uuid,integer)'::regprocedure;
 IF md5(p.prosrc)<>'18e6c2541c8d13062478fe22b4670147'
 OR NOT ('plan_cache_mode=force_generic_plan'=ANY(p.proconfig))
 OR NOT ('enable_indexscan=off'=ANY(p.proconfig))
 OR NOT ('search_path=public'=ANY(p.proconfig)) OR NOT p.prosecdef
 OR p.proowner<>'postgres'::regrole
 THEN RAISE EXCEPTION 'Bomb catchup qualified generic plan or source changed'; END IF;
 IF has_function_privilege('authenticated',p.oid,'EXECUTE')
 OR has_function_privilege('anon',p.oid,'EXECUTE')
 OR NOT has_function_privilege('service_role',p.oid,'EXECUTE')
 THEN RAISE EXCEPTION 'Bomb private authority changed'; END IF;
 PERFORM public.fn_ca_bomb_pot_catchup('11111111-1111-4111-8111-111111111111',1);
 IF current_setting('plan_cache_mode')<>before_mode
 THEN RAISE EXCEPTION 'Bomb cache setting escaped its call'; END IF;
 RAISE NOTICE 'PASS: first-call generic plan, exact body, private authority and setting restoration';
END $test$;
