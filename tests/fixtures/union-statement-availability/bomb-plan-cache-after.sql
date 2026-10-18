SELECT set_config('app.user_id','00000000-0000-4000-8000-000000000002',false);
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
 SELECT * INTO p FROM pg_proc WHERE oid='public.fn_club_bomb_pot_report(uuid,integer)'::regprocedure;
 IF md5(p.prosrc)<>'5e7475c0d116253e5562a04be594eadf' OR NOT ('plan_cache_mode=force_generic_plan'=ANY(p.proconfig))
 OR NOT p.prosecdef OR p.proowner<>'postgres'::regrole OR NOT ('search_path=public'=ANY(p.proconfig))
 THEN RAISE EXCEPTION 'Final report hosted relation, source or authority changed'; END IF;
 IF has_function_privilege('anon',p.oid,'EXECUTE') OR NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
 THEN RAISE EXCEPTION 'Final report caller authority changed'; END IF;
 RAISE NOTICE 'PASS: first-call generic plan, exact body, private authority and setting restoration';
END $test$;

-- The hosted relation retains real rows, separates clubs and excludes future dates.
INSERT INTO hand_history
 SELECT '00000000-0000-4000-8000-000000000091',table_id,bomb_pot,
        ((current_date+2)::timestamp AT TIME ZONE 'UTC'),999,9,players
 FROM hand_history WHERE table_id='00000000-0000-4000-8000-000000000003' LIMIT 1;
INSERT INTO hand_history
 SELECT '00000000-0000-4000-8000-000000000092',table_id,bomb_pot,
        (current_date::timestamp AT TIME ZONE 'UTC')+interval '1 hour',7,.5,players
 FROM hand_history WHERE table_id='00000000-0000-4000-8000-000000000003' LIMIT 1;
DO $test$
DECLARE j jsonb; before_mode text:=current_setting('plan_cache_mode');
BEGIN
 j:=public.fn_club_bomb_pot_report_v2('00000000-0000-4000-8000-000000000003',1);
 IF jsonb_array_length(j->'rows')<>1 OR (j->'rows'->0->>'total_pot')::numeric<>7
 OR (j->'rows'->0->>'total_rake')::numeric<>.5 OR (j->>'window_start')::date<>current_date
 OR (j->>'window_end')::date<>current_date THEN RAISE EXCEPTION 'Final report current/future UTC bound wrong: %',j; END IF;
 j:=public.fn_club_bomb_pot_report_v2('00000000-0000-4000-8000-000000000004',30);
 IF jsonb_array_length(j->'rows')<>1 OR j->'rows'->0->>'table_id'<>'00000000-0000-4000-8000-000000000004' OR (j->'rows'->0->>'total_pot')::numeric<>100 THEN RAISE EXCEPTION 'Final report crossed hosted clubs or lost its archive: %',j; END IF;
 IF current_setting('plan_cache_mode')<>before_mode THEN RAISE EXCEPTION 'Final report setting escaped its call'; END IF;
 IF (SELECT hash FROM bomb_archive_before) IS DISTINCT FROM (SELECT md5(string_agg(to_jsonb(d)::text,',' ORDER BY club_id,day,table_id)) FROM ca_club_bomb_pot_daily d)
 THEN RAISE EXCEPTION 'Final report rewrote sealed history'; END IF;
 RAISE NOTICE 'PASS: final hosted report preserves actual rows, UTC bounds, club isolation and sealed archive';
END $test$;
