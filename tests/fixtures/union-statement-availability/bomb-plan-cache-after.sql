SELECT set_config('app.user_id','00000000-0000-4000-8000-000000000002',false);
SELECT set_config('TimeZone','UTC',false);
DO $test$
DECLARE p record; sig text; body_hash text; browser boolean;
 before_mode text:=current_setting('plan_cache_mode');
 before_index text:=current_setting('enable_indexscan');
 before_mem text:=current_setting('work_mem');
 before_timeout text:=current_setting('statement_timeout');
BEGIN
 FOR sig,body_hash,browser IN VALUES
 ('public.fn_ca_bomb_pot_catchup(uuid,integer)','15849f150f1bd952f81f7359f4025fd0',false),
 ('public.fn_club_bomb_pot_report(uuid,integer)','2b3b339a07cd25ab7eb9a290b982ea9f',true),
 ('public.fn_ca_bomb_pot_rollup_day(uuid,date)','66acef690a6a5caf35a23843a17730b6',false),
 ('public.fn_club_bomb_pot_report_v2(uuid,integer)','88a1711928ffc5db32414499af026e97',true)
 LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=sig::regprocedure;
  IF md5(p.prosrc)<>body_hash OR NOT p.prosecdef OR p.proowner<>'postgres'::regrole
  OR NOT ('search_path=public'=ANY(p.proconfig))
  OR NOT ('plan_cache_mode=force_generic_plan'=ANY(p.proconfig))
  OR NOT ('enable_indexscan=off'=ANY(p.proconfig))
  OR NOT ('work_mem=64MB'=ANY(p.proconfig))
  OR NOT ('statement_timeout=30s'=ANY(p.proconfig))
  THEN RAISE EXCEPTION 'Bomb catchup qualified generic plan or source changed: %',sig; END IF;
  IF has_function_privilege('anon',p.oid,'EXECUTE')
  OR has_function_privilege('authenticated',p.oid,'EXECUTE') IS DISTINCT FROM browser
  OR NOT has_function_privilege('service_role',p.oid,'EXECUTE')
  THEN RAISE EXCEPTION 'Bomb private or reader authority changed: %',sig; END IF;
 END LOOP;
 PERFORM public.fn_ca_bomb_pot_catchup('11111111-1111-4111-8111-111111111111',1);
 IF current_setting('plan_cache_mode')<>before_mode OR current_setting('enable_indexscan')<>before_index
 OR current_setting('work_mem')<>before_mem OR current_setting('statement_timeout')<>before_timeout
 THEN RAISE EXCEPTION 'Bomb cache setting escaped its call'; END IF;
 RAISE NOTICE 'PASS: exact four report stages, source hashes, private authority and scoped budgets';
END $test$;

INSERT INTO hand_history
 SELECT '00000000-0000-4000-8000-000000000091',table_id,bomb_pot,
        ((current_date+2)::timestamp AT TIME ZONE 'UTC'),999,9,players
 FROM hand_history WHERE table_id='00000000-0000-4000-8000-000000000003' LIMIT 1;
INSERT INTO hand_history
 SELECT '00000000-0000-4000-8000-000000000092',table_id,bomb_pot,
        (current_date::timestamp AT TIME ZONE 'UTC')+interval '1 hour',7,.5,players
 FROM hand_history WHERE table_id='00000000-0000-4000-8000-000000000003' LIMIT 1;
INSERT INTO bomb_pot_award_units VALUES('00000000-0000-4000-8000-000000000092','00000000-0000-4000-8000-000000000002',(current_date::timestamp AT TIME ZONE 'UTC')+interval '61 minutes');
DO $test$
DECLARE j jsonb; before_mode text:=current_setting('plan_cache_mode'); before_zone text:=current_setting('TimeZone');
 before_mem text:=current_setting('work_mem'); before_timeout text:=current_setting('statement_timeout'); before_index text:=current_setting('enable_indexscan');
 archived jsonb; utc_today date:=(now() AT TIME ZONE 'UTC')::date;
BEGIN
 j:=public.fn_club_bomb_pot_report_v2('00000000-0000-4000-8000-000000000003',1);
 IF jsonb_array_length(j->'rows')<>1 OR (j->'rows'->0->>'total_pot')::numeric<>7
 OR (j->'rows'->0->>'total_rake')::numeric<>.5 OR (j->>'window_start')::date<>utc_today
 OR (j->>'window_end')::date<>utc_today THEN RAISE EXCEPTION 'Final report current/future UTC bound wrong: %',j; END IF;
 PERFORM set_config('TimeZone','Pacific/Kiritimati',true);
 j:=public.fn_club_bomb_pot_report_v2('00000000-0000-4000-8000-000000000003',1);
 IF (j->'rows'->0->>'total_pot')::numeric<>7 OR (j->>'window_end')::date<>utc_today
 THEN RAISE EXCEPTION 'Session timezone moved the UTC window: %',j; END IF;
 PERFORM set_config('TimeZone','America/Los_Angeles',true);
 j:=public.fn_club_bomb_pot_report_v2('00000000-0000-4000-8000-000000000003',1);
 IF (j->'rows'->0->>'scoops')::integer<>1 OR (j->'rows'->0->>'unrecorded_hands')::integer<>0
 THEN RAISE EXCEPTION 'Session timezone moved award attribution: %',j; END IF;
 PERFORM set_config('TimeZone',before_zone,true);
 j:=public.fn_club_bomb_pot_report_v2('00000000-0000-4000-8000-000000000004',30);
 IF jsonb_array_length(j->'rows')<>1 OR j->'rows'->0->>'table_id'<>'00000000-0000-4000-8000-000000000004'
 OR (j->'rows'->0->>'total_pot')::numeric<>100 THEN RAISE EXCEPTION 'Final report crossed hosted clubs or lost archive: %',j; END IF;
 IF (SELECT hash FROM bomb_archive_before) IS DISTINCT FROM
  (SELECT md5(string_agg(to_jsonb(d)::text,',' ORDER BY club_id,day,table_id)) FROM ca_club_bomb_pot_daily d WHERE day=utc_today-7)
 THEN RAISE EXCEPTION 'Final report rewrote sealed history'; END IF;
 j:=public.fn_club_bomb_pot_report_v2('00000000-0000-4000-8000-000000000003',7);
 IF (j->'rows'->0->>'hands')::integer<>2 OR (j->'rows'->0->>'total_pot')::numeric<>27
 OR (j->'rows'->0->>'total_rake')::numeric<>1.5
 OR (j->'rows'->0->>'scoops')::integer<>1 OR (j->'rows'->0->>'splits')::integer<>0
 OR (j->'rows'->0->>'unrecorded_hands')::integer<>1 OR (j->'rows'->0->>'total_antes')::numeric<>4
 OR (j->'rows'->0->>'avg_pot')::numeric<>13.5 OR (j->'rows'->0->>'avg_players')::numeric<>2
 THEN RAISE EXCEPTION 'Real rollup producer lost closed or live hand values: %',j; END IF;
 SELECT to_jsonb(c) INTO archived FROM ca_club_bomb_pot_complete c WHERE club_id='00000000-0000-4000-8000-000000000003' AND day=utc_today-2;
 IF archived IS NULL OR (archived->>'hands_read')::bigint<>1 THEN RAISE EXCEPTION 'Real producer did not seal actual source'; END IF;
 PERFORM public.fn_club_bomb_pot_report_v2('00000000-0000-4000-8000-000000000003',7);
 IF archived IS DISTINCT FROM (SELECT to_jsonb(c) FROM ca_club_bomb_pot_complete c WHERE club_id='00000000-0000-4000-8000-000000000003' AND day=utc_today-2)
 THEN RAISE EXCEPTION 'Repeat read recomputed sealed source'; END IF;
 PERFORM public.fn_ca_bomb_pot_rollup_day('00000000-0000-4000-8000-000000000003',utc_today-2);
 IF archived IS DISTINCT FROM (SELECT to_jsonb(c) FROM ca_club_bomb_pot_complete c WHERE club_id='00000000-0000-4000-8000-000000000003' AND day=utc_today-2) THEN RAISE EXCEPTION 'Direct duplicate rewrote sealed source'; END IF;
 IF current_setting('plan_cache_mode')<>before_mode OR current_setting('work_mem')<>before_mem OR current_setting('statement_timeout')<>before_timeout OR current_setting('enable_indexscan')<>before_index THEN RAISE EXCEPTION 'Final report setting escaped its call'; END IF;
 RAISE NOTICE 'PASS: real archive producer, nonempty pot/rake, midnight grace, UTC timezone, future exclusion, club isolation and idempotent sealed archive';
END $test$;

INSERT INTO clubs(id,name,code,slug,owner_id) VALUES('00000000-0000-4000-8000-000000000006','Long Source','999','long-source','00000000-0000-4000-8000-000000000002');
INSERT INTO club_members VALUES('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000002','owner');
INSERT INTO tables VALUES('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000006','Long Source');
INSERT INTO hand_history
 SELECT md5('bomb-long-'||g)::uuid,'00000000-0000-4000-8000-000000000006',
 '{"trigger_reason":"interval","board_count":2,"variant":"plo4","ante_amount":1}'::jsonb,
 ((current_date-g)::timestamp AT TIME ZONE 'UTC')+interval '18 hours',10,.1,'[{},{}]'::jsonb
 FROM generate_series(1,42) g;
DO $test$
DECLARE j jsonb; closed integer; before_zone text:=current_setting('TimeZone');
BEGIN
 PERFORM set_config('TimeZone','Pacific/Kiritimati',true);
 j:=public.fn_club_bomb_pot_report_v2('00000000-0000-4000-8000-000000000006',90);
 IF (SELECT count(*) FROM ca_club_bomb_pot_complete WHERE club_id='00000000-0000-4000-8000-000000000006')<>40
 OR (j->'rows'->0->>'hands')::integer<>42 OR (j->'rows'->0->>'total_pot')::numeric<>420
 OR (j->'rows'->0->>'total_rake')::numeric<>4.2
 THEN RAISE EXCEPTION 'Saturation must retain unsealed history: %',j; END IF;
 PERFORM set_config('TimeZone',before_zone,true);
 SELECT count(*) INTO closed FROM hand_history WHERE table_id='00000000-0000-4000-8000-000000000006'
 AND created_at<(((now()-interval '15 minutes') AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC');
 j:=public.fn_club_bomb_pot_report_v2('00000000-0000-4000-8000-000000000006',90);
 IF (SELECT count(*) FROM ca_club_bomb_pot_complete WHERE club_id='00000000-0000-4000-8000-000000000006')<>closed
 OR (j->'rows'->0->>'hands')::integer<>42 THEN RAISE EXCEPTION 'Exhausted catchup lost recorded history: %',j; END IF;
 RAISE NOTICE 'PASS: forty-day saturation preserves all forty-two source days and exhaustive catchup preserves the live grace';
END $test$;
