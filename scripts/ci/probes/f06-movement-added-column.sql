-- A column added after a movement proof was taken is not a changed hand
-- (migration 20260926043127). Runs on the installed mixed-custody foundation
-- after that migration; every scene rolls back.
--
-- The scene is the real parked source b7300000-...04: its original manager
-- admits movement custody (the proof is captured from the live sealed rows),
-- then hand_history and hand_atomic_commits each gain a nullable column, as
-- 20260924034010 gave hand_history kill_pot in production. The original proof
-- must still prove, a successor must be able to re-admit carrying that same
-- proof and move the players, and every changed fact must still refuse.
BEGIN;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
CREATE FUNCTION pg_temp.added_check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ADDED_COLUMN FAIL: %',label; END IF;
 RAISE NOTICE 'ADDED_COLUMN PASS: %',label; END $$;
CREATE FUNCTION pg_temp.added_state() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r record;v jsonb;result jsonb:='{}';BEGIN
 FOR r IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN('public','smarter_private') ORDER BY 1,2 LOOP
 EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]'') FROM %I.%I r',r.schemaname,r.tablename) INTO v;
 result:=result||jsonb_build_object(r.schemaname||'.'||r.tablename,v); END LOOP;RETURN result; END $$;
CREATE FUNCTION pg_temp.added_refuses(command text,reason text,label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE before jsonb:=pg_temp.added_state();seen text;BEGIN
 BEGIN EXECUTE command;RAISE EXCEPTION 'EXPECTED_REFUSAL_MISSING';EXCEPTION WHEN OTHERS THEN
 GET STACKED DIAGNOSTICS seen=MESSAGE_TEXT;IF position(reason IN seen)=0 THEN RAISE EXCEPTION 'ADDED_COLUMN FAIL: %, expected %, got %',label,reason,seen;END IF;END;
 PERFORM pg_temp.added_check(pg_temp.added_state()=before,label||' rolls back');END $$;
CREATE FUNCTION pg_temp.added_proves(label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE seen text;BEGIN
 BEGIN PERFORM smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004';
 EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS seen=MESSAGE_TEXT; RAISE EXCEPTION 'ADDED_COLUMN FAIL: %, got %',label,seen; END;
 PERFORM pg_temp.added_check(true,label); END $$;
-- The strict pre-image comparison, rebuilt from the installed body by
-- restoring exactly the two comparisons the migration replaced.
CREATE FUNCTION pg_temp.added_strict() RETURNS text LANGUAGE sql AS $f$
 SELECT 'CREATE OR REPLACE FUNCTION smarter_private.f06_assert_movement(p_break uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS '||quote_literal(
  replace(replace(prosrc,
   $r$(SELECT jsonb_object_agg(c.key,c.value) FROM jsonb_each(to_jsonb(x)) c WHERE a.proof->'atomic' ? c.key OR c.value<>'null'::jsonb)=a.proof->'atomic'$r$,
   $r$to_jsonb(x)=a.proof->'atomic'$r$),
   $r$(SELECT jsonb_object_agg(c.key,c.value) FROM jsonb_each(to_jsonb(x)) c WHERE a.proof->'history' ? c.key OR c.value<>'null'::jsonb)=a.proof->'history'$r$,
   $r$to_jsonb(x)=a.proof->'history'$r$))||';'
 FROM pg_proc WHERE oid='smarter_private.f06_assert_movement(uuid)'::regprocedure $f$;

SELECT public.fn_eliminate_tournament_player_atomic('b7200000-0000-4000-8000-000000000004','b7100000-0000-4000-8000-000000000007',2,0,0);
SELECT set_config('app.smarter_data_actor','tournament-manager',true);
SELECT set_config('app.smarter_tournament_id','b7200000-0000-4000-8000-000000000004',true);
SELECT set_config('app.smarter_tournament_lease_generation','b7500000-0000-4000-8000-000000000004',true);
SELECT pg_temp.added_check(granted,'original manager claims the lease') FROM public.claim_tournament_lease_v2('b7200000-0000-4000-8000-000000000004','added-column-original','qualified','b7500000-0000-4000-8000-000000000004',30);
DO $$ DECLARE o smarter_private.f06_operations; admitted jsonb; BEGIN
 SELECT * INTO STRICT o FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004';
 admitted:=public.fn_f06_admit_parked_movement(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.source_table_id,o.lifecycle,o.break_id,
 'b7600000-0000-4000-8000-000000000004','b7700000-0000-4000-8000-000000000004',o.revision);
 PERFORM pg_temp.added_check(admitted->>'mode'='movement_only','original admission captures the proof');
END $$;
SELECT pg_temp.added_check(NOT (a.proof->'history' ? 'added_after_proof') AND NOT (a.proof->'atomic' ? 'added_after_proof'),'the proof predates the added column')
 FROM smarter_private.f06_movement_admissions a WHERE a.admission_id='b7600000-0000-4000-8000-000000000004';
SELECT pg_temp.added_proves('the proof proves before any column is added');

-- The production shape: a nullable column added after the proof, null on
-- every row. Same for the atomic commit, which carries the same hazard.
ALTER TABLE public.hand_history ADD COLUMN added_after_proof jsonb NULL;
ALTER TABLE public.hand_atomic_commits ADD COLUMN added_after_proof jsonb NULL;
SELECT pg_temp.added_proves('a null column added to hand_history and hand_atomic_commits after the proof still proves');

-- Red before: the strict pre-image refuses exactly this state for ever.
SAVEPOINT strict_preimage;
SELECT pg_temp.added_check(md5(prosrc)='0cbea76808f835945a63f91f03e7d91c','the installed body is the migration post-image')
 FROM pg_proc WHERE oid='smarter_private.f06_assert_movement(uuid)'::regprocedure;
DO $$ BEGIN EXECUTE pg_temp.added_strict(); END $$;
SELECT pg_temp.added_check(md5(prosrc)='1bc767e267e5b90534c601c39f2790a0','restoring the two comparisons reproduces the pre-image')
 FROM pg_proc WHERE oid='smarter_private.f06_assert_movement(uuid)'::regprocedure;
SELECT pg_temp.added_refuses($q$SELECT smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004'$q$,'F06_MOVEMENT_BOUNDARY_CHANGED','the pre-image refuses a null added column');
ROLLBACK TO SAVEPOINT strict_preimage;

-- Anything written into the added column is not provably inert, whatever it is.
SELECT pg_temp.added_refuses(format($q$SET LOCAL session_replication_role=replica;UPDATE public.hand_history SET added_after_proof=%L WHERE id=(SELECT (proof#>>'{history,id}')::uuid FROM smarter_private.f06_movement_admissions WHERE admission_id='b7600000-0000-4000-8000-000000000004');SET LOCAL session_replication_role=origin;SELECT smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004'$q$,v),'F06_MOVEMENT_BOUNDARY_CHANGED','a history value '||v||' in the added column refuses')
 FROM unnest(ARRAY['{}','{"kill":"half"}','false','0','""','[]']) v;
SELECT pg_temp.added_refuses(format($q$SET LOCAL session_replication_role=replica;UPDATE public.hand_atomic_commits SET added_after_proof=%L WHERE hand_id=(SELECT (proof#>>'{atomic,hand_id}')::uuid FROM smarter_private.f06_movement_admissions WHERE admission_id='b7600000-0000-4000-8000-000000000004');SET LOCAL session_replication_role=origin;SELECT smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004'$q$,v),'F06_MOVEMENT_BOUNDARY_CHANGED','an atomic value '||v||' in the added column refuses')
 FROM unnest(ARRAY['{}','false','0']) v;
-- A column added with a non-null default cannot be told from a written value.
SELECT pg_temp.added_refuses($q$ALTER TABLE public.hand_history ADD COLUMN added_with_default text NOT NULL DEFAULT 'off';SELECT smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004'$q$,'F06_MOVEMENT_BOUNDARY_CHANGED','an added column with a non-null default refuses');
-- Every proven fact still compares exactly: a changed value, a proven value
-- that became null, and a proven column that is gone.
SELECT pg_temp.added_refuses($q$SET LOCAL session_replication_role=replica;UPDATE public.hand_history SET players=players||'[{"changed":true}]'::jsonb WHERE id=(SELECT (proof#>>'{history,id}')::uuid FROM smarter_private.f06_movement_admissions WHERE admission_id='b7600000-0000-4000-8000-000000000004');SET LOCAL session_replication_role=origin;SELECT smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004'$q$,'F06_MOVEMENT_BOUNDARY_CHANGED','a changed proven history value refuses');
SELECT pg_temp.added_refuses($q$SET LOCAL session_replication_role=replica;UPDATE public.hand_atomic_commits SET stack_result=stack_result||'{"changed":true}'::jsonb WHERE hand_id=(SELECT (proof#>>'{atomic,hand_id}')::uuid FROM smarter_private.f06_movement_admissions WHERE admission_id='b7600000-0000-4000-8000-000000000004');SET LOCAL session_replication_role=origin;SELECT smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004'$q$,'F06_MOVEMENT_BOUNDARY_CHANGED','a changed proven atomic value refuses');
SELECT pg_temp.added_refuses(format($q$SET LOCAL session_replication_role=replica;UPDATE public.hand_history SET %I=NULL WHERE id=(SELECT (proof#>>'{history,id}')::uuid FROM smarter_private.f06_movement_admissions WHERE admission_id='b7600000-0000-4000-8000-000000000004');SET LOCAL session_replication_role=origin;SELECT smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004'$q$,k),'F06_MOVEMENT_BOUNDARY_CHANGED','a proven history value that became null refuses')
 FROM (SELECT e.key k FROM smarter_private.f06_movement_admissions a, jsonb_each(a.proof->'history') e
        JOIN pg_attribute t ON t.attrelid='public.hand_history'::regclass AND t.attname=e.key AND NOT t.attnotnull
       WHERE a.admission_id='b7600000-0000-4000-8000-000000000004' AND e.value<>'null'::jsonb ORDER BY 1 LIMIT 1) n;
SELECT pg_temp.added_refuses(format($q$ALTER TABLE public.hand_history DROP COLUMN %I;SELECT smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004'$q$,k),'F06_MOVEMENT_BOUNDARY_CHANGED','a proven history column that is gone refuses')
 FROM (SELECT e.key k FROM smarter_private.f06_movement_admissions a, jsonb_each(a.proof->'history') e
        JOIN pg_attribute t ON t.attrelid='public.hand_history'::regclass AND t.attname=e.key AND NOT t.attnotnull
         AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.refobjid=t.attrelid AND d.refobjsubid=t.attnum AND d.deptype<>'a')
       WHERE a.admission_id='b7600000-0000-4000-8000-000000000004' AND e.value='null'::jsonb ORDER BY 1 LIMIT 1) n;
-- The other boundary checks are untouched: a later hand still refuses.
SELECT pg_temp.added_refuses($q$SET LOCAL session_replication_role=replica;INSERT INTO public.hand_history SELECT (jsonb_populate_record(NULL::public.hand_history,to_jsonb(h)||jsonb_build_object('id',gen_random_uuid(),'hand_number',h.hand_number+1))).* FROM public.hand_history h WHERE id=(SELECT (proof#>>'{history,id}')::uuid FROM smarter_private.f06_movement_admissions WHERE admission_id='b7600000-0000-4000-8000-000000000004');SET LOCAL session_replication_role=origin;SELECT smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004'$q$,'F06_MOVEMENT_BOUNDARY_CHANGED','a later hand on the source still refuses');

-- The production path: a successor re-admits carrying the ORIGINAL proof,
-- begins the break and moves the players, with the added column in place.
SELECT public.release_tournament_leases_v2('added-column-original',jsonb_build_array(jsonb_build_object('tournament_id','b7200000-0000-4000-8000-000000000004','lease_generation','b7500000-0000-4000-8000-000000000004')));
SELECT set_config('app.smarter_tournament_lease_generation','b7500000-0000-4000-8000-0000000000a1',true);
SELECT pg_temp.added_check(granted,'successor claims the lease') FROM public.claim_tournament_lease_v2('b7200000-0000-4000-8000-000000000004','added-column-successor','qualified','b7500000-0000-4000-8000-0000000000a1',30);
DO $$ DECLARE o smarter_private.f06_operations; admitted jsonb; again jsonb; BEGIN
 SELECT * INTO STRICT o FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004';
 admitted:=public.fn_f06_admit_parked_movement(o.tournament_id,'b7500000-0000-4000-8000-0000000000a1',o.source_table_id,o.lifecycle,o.break_id,
 'b7600000-0000-4000-8000-0000000000a1','b7700000-0000-4000-8000-0000000000a1',o.revision);
 PERFORM pg_temp.added_check(admitted->>'mode'='movement_only' AND admitted->>'lease_generation'='b7500000-0000-4000-8000-0000000000a1','successor admission succeeds with the added column');
 PERFORM pg_temp.added_check((SELECT n.proof=p.proof AND n.proof_hash=p.proof_hash FROM smarter_private.f06_movement_admissions n, smarter_private.f06_movement_admissions p
   WHERE n.admission_id='b7600000-0000-4000-8000-0000000000a1' AND p.admission_id='b7600000-0000-4000-8000-000000000004'),'the successor carries the original proof byte for byte');
 again:=public.fn_f06_admit_parked_movement(o.tournament_id,'b7500000-0000-4000-8000-0000000000a1',o.source_table_id,o.lifecycle,o.break_id,
 'b7600000-0000-4000-8000-0000000000a1','b7700000-0000-4000-8000-0000000000a1',o.revision);
 PERFORM pg_temp.added_check(again=admitted,'a lost admission reply replays the same admission');
END $$;
SELECT pg_temp.added_refuses($q$SET LOCAL session_replication_role=replica;UPDATE public.hand_history SET added_after_proof='{}' WHERE id=(SELECT (proof#>>'{history,id}')::uuid FROM smarter_private.f06_movement_admissions WHERE admission_id='b7600000-0000-4000-8000-000000000004');SET LOCAL session_replication_role=origin;SELECT public.fn_f06_admit_parked_movement(o.tournament_id,'b7500000-0000-4000-8000-0000000000a1',o.source_table_id,o.lifecycle,o.break_id,'b7600000-0000-4000-8000-0000000000a1','b7700000-0000-4000-8000-0000000000a1',(SELECT requested_revision FROM smarter_private.f06_movement_admissions WHERE admission_id='b7600000-0000-4000-8000-0000000000a1')) FROM smarter_private.f06_operations o WHERE source_table_id='b7300000-0000-4000-8000-000000000004'$q$,'F06_MOVEMENT_BOUNDARY_CHANGED','a written added column refuses the successor admission');
DO $$ DECLARE o smarter_private.f06_operations; manifest jsonb; x jsonb; chips_before numeric; chips_after numeric; BEGIN
 SELECT * INTO STRICT o FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004';
 SELECT sum(stack) INTO chips_before FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id=o.tournament_id AND s.left_at IS NULL;
 SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'source_seat_id',s.id,'source_seat_number',s.seat_number,
 'occupancy_id',s.occupancy_id,'request_id',CASE WHEN s.user_id::text LIKE '%000008' THEN 'b7a00000-0000-4000-8000-0000000000a1' ELSE 'b7a00000-0000-4000-8000-0000000000a2' END,
 'destination_table_id',CASE WHEN s.user_id::text LIKE '%000008' THEN 'b7300000-0000-4000-8000-000000000005' ELSE 'b7300000-0000-4000-8000-000000000006' END,
 'destination_seat_number',1) ORDER BY s.user_id) INTO manifest FROM public.table_seats s WHERE s.table_id=o.source_table_id AND s.left_at IS NULL;
 PERFORM public.fn_f06_begin_break(o.tournament_id,'b7500000-0000-4000-8000-0000000000a1',o.break_id,manifest);
 FOR x IN SELECT value FROM jsonb_array_elements(manifest) LOOP
  PERFORM public.fn_move_tournament_player(o.tournament_id,(x->>'user_id')::uuid,o.source_table_id,(x->>'destination_table_id')::uuid,1,(x->>'request_id')::uuid,'live_source');
 END LOOP;
 SELECT sum(stack) INTO chips_after FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id=o.tournament_id AND s.left_at IS NULL;
 PERFORM pg_temp.added_check(NOT EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=o.source_table_id AND left_at IS NULL),'the successor moves every source player with the added column in place');
 PERFORM pg_temp.added_check(chips_after=chips_before,'the moves carry every chip: seated total unchanged');
 PERFORM pg_temp.added_check((SELECT count(*)=max(jsonb_array_length(a.proof->'roster')) AND count(*)>0 AND bool_and(s.stack=(r.v#>>'{seat,stack}')::numeric AND p.chips::numeric=s.stack AND s.table_id<>o.source_table_id)
   FROM smarter_private.f06_movement_admissions a, jsonb_array_elements(a.proof->'roster') r(v)
   JOIN public.table_seats s ON s.user_id=(r.v#>>'{seat,user_id}')::uuid AND s.left_at IS NULL
   JOIN public.tournament_players p ON p.user_id=s.user_id AND p.tournament_id=o.tournament_id
   WHERE a.admission_id='b7600000-0000-4000-8000-0000000000a1'),'each moved player sits at a destination with exactly the proven stack and registration chips');
END $$;
DO $$ BEGIN RAISE NOTICE 'ADDED_COLUMN_COMPLETE'; END $$;
ROLLBACK;
