-- Isolated canonical business functions. Every synthetic scene rolls back.
BEGIN;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
CREATE FUNCTION pg_temp.mixed_check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'MIXED_CUSTODY FAIL: %',label; END IF;
 RAISE NOTICE 'MIXED_CUSTODY PASS: %',label; END $$;
CREATE FUNCTION pg_temp.mixed_state() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r record;v jsonb;result jsonb:='{}';BEGIN
 FOR r IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN('public','smarter_private','auth') ORDER BY 1,2 LOOP
 EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]'') FROM %I.%I r',r.schemaname,r.tablename) INTO v;
 result:=result||jsonb_build_object(r.schemaname||'.'||r.tablename,v); END LOOP;RETURN result; END $$;
CREATE FUNCTION pg_temp.mixed_refuses(command text,reason text,label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE before jsonb:=pg_temp.mixed_state();seen text;BEGIN
 BEGIN EXECUTE command;RAISE EXCEPTION 'EXPECTED_REFUSAL_MISSING';EXCEPTION WHEN OTHERS THEN
 GET STACKED DIAGNOSTICS seen=MESSAGE_TEXT;IF position(reason IN seen)=0 THEN RAISE EXCEPTION 'MIXED_CUSTODY FAIL: %, expected %, got %',label,reason,seen;END IF;END;
 PERFORM pg_temp.mixed_check(pg_temp.mixed_state()=before,label||' rollback');END $$;
SELECT public.fn_eliminate_tournament_player_atomic('b7200000-0000-4000-8000-000000000004','b7100000-0000-4000-8000-000000000007',2,0,0);
SELECT set_config('app.smarter_data_actor','tournament-manager',true);
SELECT set_config('app.smarter_tournament_id','b7200000-0000-4000-8000-000000000004',true);
SELECT set_config('app.smarter_tournament_lease_generation','b7500000-0000-4000-8000-000000000004',true);
SELECT pg_temp.mixed_check(granted,'old manager claims canonical lease') FROM public.claim_tournament_lease_v2('b7200000-0000-4000-8000-000000000004','mixed-custody-original','qualified','b7500000-0000-4000-8000-000000000004',30);
DO $$ DECLARE o smarter_private.f06_operations;manifest jsonb;x jsonb;BEGIN
 SELECT * INTO STRICT o FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004';
 PERFORM public.fn_f06_admit_parked_movement(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.source_table_id,o.lifecycle,o.break_id,
 'b7600000-0000-4000-8000-000000000004','b7700000-0000-4000-8000-000000000004',0);
 SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'source_seat_id',s.id,'source_seat_number',s.seat_number,
 'occupancy_id',s.occupancy_id,'request_id',CASE WHEN s.user_id::text LIKE '%000008' THEN 'b7a00000-0000-4000-8000-000000000001' ELSE 'b7a00000-0000-4000-8000-000000000002' END,
 'destination_table_id',CASE WHEN s.user_id::text LIKE '%000008' THEN 'b7300000-0000-4000-8000-000000000005' ELSE 'b7300000-0000-4000-8000-000000000006' END,
 'destination_seat_number',1) ORDER BY s.user_id) INTO manifest FROM public.table_seats s WHERE s.table_id=o.source_table_id AND s.left_at IS NULL;
 PERFORM public.fn_f06_begin_break(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.break_id,manifest);
 x:=manifest->0;
 PERFORM public.fn_move_tournament_player(o.tournament_id,(x->>'user_id')::uuid,o.source_table_id,(x->>'destination_table_id')::uuid,1,(x->>'request_id')::uuid,'live_source');
END $$;
-- A reserved original on a destination is deliberately not a source park.
INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation)
SELECT 'b7800000-0000-4000-8000-000000000005',tournament_id,id,f06_lifecycle,9721005,'b7900000-0000-4000-8000-000000000005','b7500000-0000-4000-8000-000000000004'
FROM public.tables WHERE id='b7300000-0000-4000-8000-000000000005';
CREATE FUNCTION pg_temp.mixed_local() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('manager_id','b7500000-0000-4000-8000-000000000090','move_owner','b7500000-0000-4000-8000-000000000091',
 'engines',(SELECT jsonb_agg(jsonb_build_object('table_id',tb.id,'engine_id',tb.id,'lifecycle',tb.f06_lifecycle::text,'bank_custody',jsonb_build_object('hand_number',COALESCE((ep.time_bank_snapshot->>'handNumber')::bigint,0),
 'roster',COALESCE((SELECT jsonb_agg(jsonb_build_array(s.user_id,s.occupancy_id,s.seat_number,s.stack) ORDER BY s.seat_number) FROM public.table_seats s WHERE s.table_id=tb.id AND s.left_at IS NULL),'[]'::jsonb),
 'time_bank_metadata',COALESCE((SELECT jsonb_agg(jsonb_build_array(key,value-ARRAY['occupancyId','remainingSeconds','usesRemaining']) ORDER BY key) FROM jsonb_each(ep.time_bank_snapshot->'players')),'[]'::jsonb),
 'parked_time_banks',COALESCE(ep.time_bank_snapshot->'players','{}'::jsonb),'live_time_banks','[]'::jsonb,'disconnect_states','{}'::jsonb,'durable_presence',to_jsonb(ep)),'permit',
 CASE WHEN h.permit_id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('phase','reserved','binding',jsonb_build_object(
 'tournament_id',h.tournament_id,'lease_generation',h.generation,'table_id',h.table_id,'lifecycle',h.lifecycle::text,
 'permit_id',h.permit_id,'hand_number',h.hand_number::text,'custody_id',h.custody_id)) END) ORDER BY tb.id)
 FROM public.tables tb LEFT JOIN public.engine_presence_parked ep ON ep.table_id=tb.id LEFT JOIN smarter_private.f06_hand_permits h ON h.table_id=tb.id WHERE tb.tournament_id='b7200000-0000-4000-8000-000000000004'),
 'retained',(SELECT jsonb_agg(jsonb_build_object('table_id',source_table_id,'break_id',break_id,'engine_id',source_table_id) ORDER BY source_table_id) FROM smarter_private.f06_operations WHERE tournament_id='b7200000-0000-4000-8000-000000000004'),
 'durable',(SELECT jsonb_agg(jsonb_build_array(break_id,smarter_private.f06_state(break_id)) ORDER BY break_id) FROM smarter_private.f06_operations WHERE tournament_id='b7200000-0000-4000-8000-000000000004'),
 'pending_moves',(SELECT jsonb_agg(jsonb_build_array(a.request_id,jsonb_build_object('input',jsonb_build_object('requestId',a.request_id,'tournamentId',o.tournament_id,
 'userId',a.user_id,'sourceTableId',o.source_table_id,'destinationTableId',a.destination_table_id,'destinationSeatNumber',a.destination_seat_number,'sourceMode','live_source'))) ORDER BY a.request_id)
 FROM smarter_private.f06_attempts a JOIN smarter_private.f06_operations o USING(break_id) WHERE o.tournament_id='b7200000-0000-4000-8000-000000000004'),
 'parks','[]'::jsonb,'begins','[]'::jsonb,'amendments','[]'::jsonb,'rejected_begins','[]'::jsonb,'resolved_proposals','[]'::jsonb,'custody_ids','[]'::jsonb,'cleanup_kinds','[]'::jsonb,
 'no_start','[]'::jsonb,'stopped_originals','[]'::jsonb,'arrival_wakes','[]'::jsonb,'retirement',NULL,
 'reservations',(SELECT jsonb_agg(jsonb_build_object('table_id',source_table_id,'revision','1','binding',jsonb_build_array(tournament_id,break_id,source_table_id,lifecycle::text,custody_generation,custody_id,revision::text))) FROM smarter_private.f06_operations WHERE tournament_id='b7200000-0000-4000-8000-000000000004'));
$$;
CREATE FUNCTION pg_temp.mixed_prepare(local_proof jsonb DEFAULT pg_temp.mixed_local(),expected jsonb DEFAULT NULL,successor uuid DEFAULT 'b7500000-0000-4000-8000-000000000099') RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.fn_f06_prepare_mixed_manager_custody('b7600000-0000-4000-8000-000000000099','b7200000-0000-4000-8000-000000000004','b7500000-0000-4000-8000-000000000004',successor,local_proof,expected);
$$;
SELECT set_config('app.smarter_data_actor','service',true);
SELECT pg_temp.mixed_refuses('SELECT pg_temp.mixed_prepare()','OLD_LEASE_CHANGED','fresh old authority cannot transfer');
SAVEPOINT fresh_prepared_original;
UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '31 seconds' WHERE tournament_id='b7200000-0000-4000-8000-000000000004';
SELECT pg_temp.mixed_check(NOT has_table_privilege('service_role','smarter_private.f06_manager_custody_transfers','INSERT,UPDATE,DELETE,TRUNCATE') AND NOT has_function_privilege('authenticated','public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb)','EXECUTE'),'private receipt and service-only wrapper');
SELECT pg_temp.mixed_refuses($q$SELECT set_config('app.smarter_data_actor','tournament-manager',true);SELECT pg_temp.mixed_prepare()$q$,'SERVICE_REQUIRED','old manager actor cannot mint process transfer');
SELECT pg_temp.mixed_refuses($q$SET LOCAL ROLE authenticated;SELECT pg_temp.mixed_prepare()$q$,'permission denied','client cannot prepare');
SELECT pg_temp.mixed_refuses($q$SELECT pg_temp.mixed_prepare(NULL)$q$,'LOCAL_INVALID','absent local proof');
SELECT pg_temp.mixed_refuses($q$SELECT pg_temp.mixed_prepare(pg_temp.mixed_local()-'pending_moves')$q$,'LOCAL_INCOMPLETE','missing pending vector');
SELECT pg_temp.mixed_refuses($q$SELECT pg_temp.mixed_prepare(jsonb_set(pg_temp.mixed_local(),'{engines,0,lifecycle}','"0"'))$q$,'PHYSICAL_LIFECYCLE_CHANGED','stale engine incarnation');
SELECT pg_temp.mixed_refuses($q$SELECT pg_temp.mixed_prepare(jsonb_set(pg_temp.mixed_local(),'{engines,1,permit}','null'))$q$,'ORIGINAL_OMITTED','non-source reserved original omitted');
SELECT pg_temp.mixed_refuses($q$SELECT pg_temp.mixed_prepare(jsonb_set(pg_temp.mixed_local(),'{retained}','[]'))$q$,'SOURCE_OMITTED','source omitted');
SELECT pg_temp.mixed_refuses($q$SELECT pg_temp.mixed_prepare(jsonb_set(pg_temp.mixed_local(),'{pending_moves,0,1,input,destinationSeatNumber}','2'))$q$,'REQUEST_CHANGED','original request changed');
SELECT pg_temp.mixed_refuses($q$SELECT pg_temp.mixed_prepare(jsonb_set(pg_temp.mixed_local(),'{reservations,0,binding,6}','"999"'))$q$,'RESERVATION_CHANGED','retirement revision changed');
-- Empty historical rows carry no initialized bank; retained metadata still does.
SAVEPOINT historical_empty_bank;
INSERT INTO public.engine_presence_parked(table_id,disconnect_states,parked_at,engine_instance,time_bank_snapshot)
VALUES('b7300000-0000-4000-8000-000000000004','{}',now()-interval '1 day','historic',jsonb_build_object('version',1,'parkedAt',now()-interval '1 day','handNumber',0,'players','{}'::jsonb));
SELECT pg_temp.mixed_check(pg_temp.mixed_prepare(jsonb_set(pg_temp.mixed_local(),'{engines,0,bank_custody,hand_number}','12345'))->'ok'='true'::jsonb,'empty uninitialized historic bank is not current bank custody');
SELECT pg_temp.mixed_refuses($q$SELECT pg_temp.mixed_prepare(jsonb_set(jsonb_set(pg_temp.mixed_local(),'{engines,0,bank_custody,hand_number}','12345'),'{engines,0,bank_custody,time_bank_metadata}','[["b7100000-0000-4000-8000-000000000009",{"initialSeconds":60}]]'))$q$,'BANK_ORIGINAL_EVIDENCE_MISSING','retained metadata cannot use stale empty bank');
ROLLBACK TO SAVEPOINT historical_empty_bank;
SELECT pg_temp.mixed_refuses($q$SELECT pg_temp.mixed_prepare(jsonb_set(pg_temp.mixed_local(),'{no_start}','[["b7600000-0000-4000-8000-000000000004",{"binding":{"tableId":"b7300000-0000-4000-8000-000000000004","tableIncarnation":"1","custodyId":"b7700000-0000-4000-8000-000000000004","leaseGeneration":"b7500000-0000-4000-8000-000000000004","durableRevision":"1"},"engine_id":"b7300000-0000-4000-8000-000000000004"}]]'))$q$,'NO_START_UNRESOLVED','unknown no-start remains held');
-- The existing frozen owner is authoritative; missing/null records refuse.
SAVEPOINT frozen_checkpoint_scene;
UPDATE public.engine_tournament_leases SET instance_id='1-3846b8bb',engine_version='8825af51' WHERE tournament_id='b7200000-0000-4000-8000-000000000004';
INSERT INTO public.engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,reason,declared_by,updated_at,enforce_freeze,ownership_token)
VALUES(true,'counting_down',clock_timestamp()-interval '121 seconds',clock_timestamp()-interval '1 second',clock_timestamp()+interval '299 seconds','qualified-native','8825af51',clock_timestamp(),true,'b7900000-0000-4000-8000-000000000099');
INSERT INTO public.engine_leader(id,instance_id,engine_version,heartbeat_at) VALUES(true,'1-3846b8bb','8825af51',clock_timestamp());
CREATE TEMP TABLE frozen_local AS SELECT pg_temp.mixed_local()||jsonb_build_object('release_checkpoint',
 jsonb_build_object('kind','legacy_engine_checkpoint_8825_v1','source','8825af51817f379c4261658ca29ecc9d8d81932d','instance_id','1-3846b8bb',
 'container_id','c63b254ee71b76aa26f4d1394d96189963774310244b046bc91186e219ca3f66','process_id',1,'run_id','35405450271-1','control_sha',repeat('a',40))||
 (SELECT to_jsonb(b)-ARRAY['id','declared_by','updated_at','enforce_freeze'] FROM public.engine_maintenance_break b WHERE id=true)) AS value;
SELECT pg_temp.mixed_check(public.fn_platform_frozen() AND pg_temp.mixed_prepare((SELECT value FROM frozen_local))->'receipt'='null'::jsonb,'native frozen owner qualifies custody-only observation');
SELECT pg_temp.mixed_refuses($q$DELETE FROM public.engine_maintenance_break;SELECT pg_temp.mixed_prepare((SELECT value FROM frozen_local))$q$,'FROZEN_CHECKPOINT_UNPROVEN','missing maintenance never proves checkpoint');
SELECT pg_temp.mixed_refuses($q$DELETE FROM public.engine_leader;SELECT pg_temp.mixed_prepare((SELECT value FROM frozen_local))$q$,'FROZEN_CHECKPOINT_UNPROVEN','missing leader never proves checkpoint');
SELECT pg_temp.mixed_refuses($q$UPDATE public.engine_maintenance_break SET break_started_at=NULL;SELECT pg_temp.mixed_prepare((SELECT value FROM frozen_local))$q$,'FROZEN_CHECKPOINT_UNPROVEN','null break start never proves checkpoint');
SELECT pg_temp.mixed_refuses($q$SELECT pg_temp.mixed_prepare(jsonb_set((SELECT value FROM frozen_local),'{release_checkpoint,break_ends_at}','null'))$q$,'FROZEN_CHECKPOINT_UNPROVEN','null break end never proves checkpoint');
SELECT pg_temp.mixed_refuses($q$SELECT pg_temp.mixed_prepare(jsonb_set((SELECT value FROM frozen_local),'{release_checkpoint,announced_at}','null'))$q$,'FROZEN_CHECKPOINT_UNPROVEN','null announcement assertion refuses');
SELECT pg_temp.mixed_refuses($q$SELECT pg_temp.mixed_prepare(jsonb_set((SELECT value FROM frozen_local),'{release_checkpoint,ownership_token}','"b7900000-0000-4000-8000-000000000098"'))$q$,'FROZEN_CHECKPOINT_UNPROVEN','foreign maintenance token refuses');
SELECT pg_temp.mixed_refuses($q$UPDATE public.engine_leader SET heartbeat_at='infinity';SELECT pg_temp.mixed_prepare((SELECT value FROM frozen_local))$q$,'FROZEN_CHECKPOINT_UNPROVEN','nonfinite leader clock refuses');
SELECT pg_temp.mixed_refuses($q$UPDATE public.engine_leader SET heartbeat_at=clock_timestamp()-interval '61 seconds';SELECT pg_temp.mixed_prepare((SELECT value FROM frozen_local))$q$,'FROZEN_CHECKPOINT_UNPROVEN','stale leader refuses');
-- The reserve is the one interval literal in the installed prepare body: 285 s
-- as first installed by 20260918232558, 260 s once 20260921155216 is applied
-- (the 300 s countdown less the 285 s entry reserve less the 25 s checkpoint
-- budget). One second under it refuses and half a second over it is admitted,
-- which proves the installed integer figure exactly: 259 s refused and 260.5 s
-- admitted fit only a 260-second reserve, 284 s and 285.5 s only a 285-second one.
CREATE FUNCTION pg_temp.mixed_reserve() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE found text[];BEGIN
 SELECT regexp_matches(prosrc,$r$break_ends_at'\)::timestamptz-instant>=interval '(\d+) seconds'\)$r$,'g') INTO STRICT found FROM pg_proc WHERE oid=to_regprocedure('public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb)');
 RETURN found[1]::integer; END $$;
SELECT pg_temp.mixed_refuses(format($q$UPDATE public.engine_maintenance_break SET break_ends_at=clock_timestamp()+make_interval(secs=>%s);UPDATE frozen_local SET value=jsonb_set(value,'{release_checkpoint,break_ends_at}',(SELECT to_jsonb(break_ends_at) FROM public.engine_maintenance_break));SELECT pg_temp.mixed_prepare((SELECT value FROM frozen_local))$q$,pg_temp.mixed_reserve()-1),'FROZEN_CHECKPOINT_UNPROVEN',format('%s s remaining refuses: the installed reserve is the full %s seconds',pg_temp.mixed_reserve()-1,pg_temp.mixed_reserve()));
UPDATE public.engine_maintenance_break SET break_ends_at=clock_timestamp()+make_interval(secs=>pg_temp.mixed_reserve()+0.5);
UPDATE frozen_local SET value=jsonb_set(value,'{release_checkpoint,break_ends_at}',(SELECT to_jsonb(break_ends_at) FROM public.engine_maintenance_break));
SELECT pg_temp.mixed_check(pg_temp.mixed_prepare((SELECT value FROM frozen_local))->'receipt'='null'::jsonb,format('%s.5 s remaining is admitted: the installed reserve is not more than %s seconds',pg_temp.mixed_reserve(),pg_temp.mixed_reserve()));
ROLLBACK TO SAVEPOINT frozen_checkpoint_scene;
SELECT pg_temp.mixed_refuses($q$CREATE OR REPLACE FUNCTION public.fn_engine_lease_stale_seconds() RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=public,pg_temp AS 'SELECT 120';SELECT pg_temp.mixed_prepare()$q$,'OLD_LEASE_CHANGED','owning lease policy cannot be replaced by a literal');
DO $$ DECLARE before jsonb;observed jsonb;prepared jsonb;again jsonb;local_proof jsonb:=pg_temp.mixed_local();BEGIN
 before:=pg_temp.mixed_state();observed:=pg_temp.mixed_prepare(local_proof);
 PERFORM pg_temp.mixed_check(observed->'receipt'='null'::jsonb AND pg_temp.mixed_state()=before,'observation has zero side effects');
 PERFORM pg_temp.mixed_check(jsonb_array_length(observed#>'{canonical,attempts}')=2 AND jsonb_array_length(observed#>'{canonical,move_receipts}')=1
 AND jsonb_array_length(observed#>'{canonical,originals}')=1,'canonical vector contains active request winner and original');
 prepared:=pg_temp.mixed_prepare(local_proof,observed->'canonical');again:=pg_temp.mixed_prepare(local_proof,observed->'canonical');
 PERFORM pg_temp.mixed_check(prepared=again AND (SELECT count(*) FROM smarter_private.f06_manager_custody_transfers)=1,'lost response replays identical receipt');
 PERFORM pg_temp.mixed_check(pg_temp.mixed_state()-'smarter_private.f06_manager_custody_transfers'=before-'smarter_private.f06_manager_custody_transfers','prepare changes only transfer receipt');
 PERFORM pg_temp.mixed_refuses(format('SELECT pg_temp.mixed_prepare(%L,%L,''b7500000-0000-4000-8000-000000000098'')',local_proof,observed->'canonical'),'TRANSFER_CHANGED','new successor cannot replace original transfer');
 PERFORM pg_temp.mixed_refuses('UPDATE smarter_private.f06_manager_custody_transfers SET local_proof=''{}''','IMMUTABLE','receipt update');
 PERFORM pg_temp.mixed_refuses('DELETE FROM smarter_private.f06_manager_custody_transfers','IMMUTABLE','receipt delete');
 PERFORM pg_temp.mixed_refuses('TRUNCATE smarter_private.f06_manager_custody_transfers','IMMUTABLE','receipt truncate');
 -- Existing exact release and actual claim, no fabricated current authority.
 PERFORM public.release_tournament_leases_v2('mixed-custody-original',jsonb_build_array(jsonb_build_object('tournament_id','b7200000-0000-4000-8000-000000000004','lease_generation','b7500000-0000-4000-8000-000000000004')));
 PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
 PERFORM set_config('app.smarter_tournament_lease_generation','b7500000-0000-4000-8000-000000000099',true);
 PERFORM pg_temp.mixed_check(granted,'successor claims new protocol-2 authority') FROM public.claim_tournament_lease_v2('b7200000-0000-4000-8000-000000000004','mixed-custody-successor','qualified','b7500000-0000-4000-8000-000000000099',30);
 before:=pg_temp.mixed_state();
 PERFORM pg_temp.mixed_refuses(format('SELECT public.fn_f06_admit_mixed_manager_custody(''b7200000-0000-4000-8000-000000000004'',''b7500000-0000-4000-8000-000000000099'',''b7600000-0000-4000-8000-000000000099'',%L)',prepared->'receipt'),'ORIGINAL_DISPOSITION_REQUIRED','reserved original refuses recovery admission');
 PERFORM set_config('app.smarter_data_actor','service',true);
 PERFORM pg_temp.mixed_refuses('SELECT pg_temp.mixed_prepare()','OLD_LEASE_CHANGED','old transfer cannot run after new claim');
END $$;
-- A separate synthetic scene: its real original canceller positively records
-- non-actuation while that original lease is current. This is not a successor
-- inference and is not a disposition route for the two production hands.
ROLLBACK TO SAVEPOINT fresh_prepared_original;
SELECT set_config('app.smarter_data_actor','tournament-manager',true);
SELECT public.fn_f06_cancel_prepared_hand(tournament_id,generation,table_id,lifecycle,permit_id,hand_number,custody_id)
FROM smarter_private.f06_hand_permits WHERE permit_id='b7800000-0000-4000-8000-000000000005';
SELECT set_config('app.smarter_data_actor','service',true);
UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '31 seconds' WHERE tournament_id='b7200000-0000-4000-8000-000000000004';
-- A real native parked bank, including unlimited activations, follows only
-- its exact original winner/destination occupancy in the completion transaction.
INSERT INTO public.engine_presence_parked(table_id,disconnect_states,parked_at,engine_instance,time_bank_snapshot)
SELECT s.table_id,'{}',now(),'native-original',jsonb_build_object('version',1,'parkedAt',now(),'handNumber',
 (SELECT max(hand_number) FROM public.hand_history WHERE table_id=s.table_id),'players',jsonb_build_object(s.user_id::text,
 jsonb_build_object('occupancyId',s.occupancy_id,'remainingSeconds',47,'usesRemaining',4,'initialSeconds',60,'baseSeconds',30,'dbConsumedSeconds',13,'unlimitedActivations',true)))
FROM public.table_seats s WHERE table_id='b7300000-0000-4000-8000-000000000004' AND left_at IS NULL;
SELECT pg_temp.mixed_refuses($q$SELECT pg_temp.mixed_prepare(jsonb_set(pg_temp.mixed_local(),'{engines,0,bank_custody,hand_number}','12345'))$q$,'BANK_ORIGINAL_EVIDENCE_MISSING','initialized bank keeps exact hand requirement');
SELECT pg_temp.mixed_refuses($q$SELECT pg_temp.mixed_prepare(jsonb_set(pg_temp.mixed_local(),'{engines,0,bank_custody,roster}','[]'))$q$,'BANK_OCCUPANCY_UNPROVEN','initialized bank requires original occupancy');
DO $$ DECLARE observed jsonb;prepared jsonb;admitted jsonb;again jsonb;old_count integer;state jsonb;member jsonb;done jsonb;current_instance text;
BEGIN
 -- The compatibility capture may resolve a cleared permit's historical epoch.
 observed:=pg_temp.mixed_local();
 observed:=jsonb_set(jsonb_set(jsonb_set(observed,'{engines,1,permit}','null'),'{engines,1,allocation_epoch}','"b7900000-0000-4000-8000-000000000005"'),'{engines,1,lifecycle}','null');
 again:=pg_temp.mixed_prepare(observed);
 PERFORM pg_temp.mixed_check(jsonb_array_length(again#>'{canonical,engine_lifecycles}')=1 AND again#>>'{canonical,engine_lifecycles,0,permits,0,state}'='never_started','historical allocator row resolves capture DTO');
 PERFORM pg_temp.mixed_refuses(format('SELECT pg_temp.mixed_prepare(%L,%L)',observed,again->'canonical'),'PHYSICAL_LIFECYCLE_CHANGED','commit cannot retain null lifecycle');
 PERFORM pg_temp.mixed_refuses(format('SELECT pg_temp.mixed_prepare(%L)',jsonb_set(observed,'{engines,1,allocation_epoch}','"b7900000-0000-4000-8000-000000000098"')),'ALLOCATION_WITNESS_UNPROVEN','missing epoch rows refuse');
 observed:=jsonb_set(observed,'{engines,1,lifecycle}',again#>'{canonical,engine_lifecycles,0,lifecycle}');
 PERFORM pg_temp.mixed_check(pg_temp.mixed_prepare(observed)->'canonical'=again->'canonical','completed capture observes same canonical vector');
 observed:=pg_temp.mixed_prepare(); prepared:=pg_temp.mixed_prepare(pg_temp.mixed_local(),observed->'canonical');
 PERFORM pg_temp.mixed_check(prepared#>'{canonical,pending_original_tables}'='[]'::jsonb,'terminal receipt accounts exact original');
 PERFORM public.release_tournament_leases_v2('mixed-custody-original',jsonb_build_array(jsonb_build_object('tournament_id','b7200000-0000-4000-8000-000000000004','lease_generation','b7500000-0000-4000-8000-000000000004')));
 PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
 PERFORM set_config('app.smarter_tournament_lease_generation','b7500000-0000-4000-8000-000000000099',true);
 PERFORM pg_temp.mixed_check(granted,'restart discovery selects real preallocated claim') FROM public.claim_tournament_lease_v2('b7200000-0000-4000-8000-000000000004','mixed-custody-successor','qualified','b7500000-0000-4000-8000-000000000099',30);
 PERFORM pg_temp.mixed_refuses('SELECT smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE tournament_id=''b7200000-0000-4000-8000-000000000004''','MOVEMENT_CUSTODY_CHANGED','prepared receipt without admission grants no movement');
 admitted:=public.fn_f06_admit_mixed_manager_custody('b7200000-0000-4000-8000-000000000004','b7500000-0000-4000-8000-000000000099','b7600000-0000-4000-8000-000000000099',prepared->'receipt');
 again:=public.fn_f06_admit_mixed_manager_custody('b7200000-0000-4000-8000-000000000004','b7500000-0000-4000-8000-000000000099','b7600000-0000-4000-8000-000000000099',prepared->'receipt');
 PERFORM pg_temp.mixed_check(admitted=again AND (SELECT count(*) FROM smarter_private.f06_manager_custody_admissions)=1,'lost admission reply retains same process identity');
 PERFORM pg_temp.mixed_refuses(format('SELECT public.fn_f06_complete_mixed_manager_custody(''b7200000-0000-4000-8000-000000000004'',''b7500000-0000-4000-8000-000000000099'',''b7600000-0000-4000-8000-000000000099'',%L)',prepared->'receipt'),'RECOVERY_INCOMPLETE','active original prevents completion');
 SELECT instance_id INTO current_instance FROM public.engine_tournament_leases WHERE tournament_id='b7200000-0000-4000-8000-000000000004';
 PERFORM pg_temp.mixed_refuses(format($cmd$UPDATE public.engine_tournament_leases SET instance_id='another-process' WHERE tournament_id='b7200000-0000-4000-8000-000000000004';SELECT public.fn_f06_admit_mixed_manager_custody('b7200000-0000-4000-8000-000000000004','b7500000-0000-4000-8000-000000000099','b7600000-0000-4000-8000-000000000099',%L)$cmd$,prepared->'receipt'),'ADMITTED_PROCESS_CHANGED','partial restart cannot reuse admitted generation');
 PERFORM pg_temp.mixed_check(smarter_private.f06_mixed_movement_generation('b7600000-0000-4000-8000-000000000098') IS NULL,'unrelated break receives no transfer capability');
 PERFORM pg_temp.mixed_refuses($q$SELECT set_config('app.smarter_tournament_lease_generation','b7500000-0000-4000-8000-000000000098',true);SELECT smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE tournament_id='b7200000-0000-4000-8000-000000000004'$q$,'F06_LEASE','foreign generation cannot move originals');
 PERFORM pg_temp.mixed_refuses($q$UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '31 seconds' WHERE tournament_id='b7200000-0000-4000-8000-000000000004';SELECT smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE tournament_id='b7200000-0000-4000-8000-000000000004'$q$,'F06_LEASE','expired admitted authority cannot move');
 PERFORM pg_temp.mixed_refuses($q$UPDATE public.engine_tournament_leases SET instance_id='changed-after-admission' WHERE tournament_id='b7200000-0000-4000-8000-000000000004';SELECT smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE tournament_id='b7200000-0000-4000-8000-000000000004'$q$,'ADMITTED_PROCESS_CHANGED','changed admitted process cannot move');
 PERFORM pg_temp.mixed_refuses($q$SET LOCAL session_replication_role=replica;UPDATE public.table_seats SET occupancy_id='b7900000-0000-4000-8000-000000000098' WHERE table_id='b7300000-0000-4000-8000-000000000004' AND left_at IS NULL;SET LOCAL session_replication_role=origin;SELECT smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE tournament_id='b7200000-0000-4000-8000-000000000004'$q$,'MOVEMENT_ROSTER_CHANGED','changed original occupancy refuses');
 PERFORM pg_temp.mixed_refuses($q$SET LOCAL session_replication_role=replica;UPDATE public.table_seats SET stack=stack+1 WHERE table_id='b7300000-0000-4000-8000-000000000004' AND left_at IS NULL;SET LOCAL session_replication_role=origin;SELECT smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE tournament_id='b7200000-0000-4000-8000-000000000004'$q$,'MOVEMENT_ROSTER_CHANGED','changed source stack refuses');
 PERFORM pg_temp.mixed_refuses($q$SET LOCAL session_replication_role=replica;UPDATE public.table_seats SET table_id='b7300000-0000-4000-8000-000000000004',seat_number=10 WHERE table_id='b7300000-0000-4000-8000-000000000005' AND left_at IS NULL;SET LOCAL session_replication_role=origin;SELECT smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE tournament_id='b7200000-0000-4000-8000-000000000004'$q$,'MOVEMENT_WHOLE_ROSTER_REQUIRED','extra source player refuses');
 PERFORM pg_temp.mixed_refuses($q$INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation) SELECT 'b7800000-0000-4000-8000-000000000099',tournament_id,id,f06_lifecycle,9721999,'b7900000-0000-4000-8000-000000000099','b7500000-0000-4000-8000-000000000099' FROM public.tables WHERE id='b7300000-0000-4000-8000-000000000006'$q$,'CUSTODY_ONLY','custody admission cannot deal a new hand');
 SELECT count(*) INTO old_count FROM public.tournament_seat_move_receipts WHERE tournament_id='b7200000-0000-4000-8000-000000000004';
 SELECT smarter_private.f06_state(break_id) INTO state FROM smarter_private.f06_operations WHERE tournament_id='b7200000-0000-4000-8000-000000000004';
 FOR member IN SELECT * FROM jsonb_array_elements(state->'members') WHERE value->>'active_request_id' IS NOT NULL LOOP
 again:=public.fn_move_tournament_player('b7200000-0000-4000-8000-000000000004',(member->>'user_id')::uuid,(state->>'source_table_id')::uuid,(member->>'destination_table_id')::uuid,(member->>'destination_seat_number')::integer,(member->>'active_request_id')::uuid,'live_source');
 -- Commit-ack loss is replay of this same immutable original request.
 again:=public.fn_move_tournament_player('b7200000-0000-4000-8000-000000000004',(member->>'user_id')::uuid,(state->>'source_table_id')::uuid,(member->>'destination_table_id')::uuid,(member->>'destination_seat_number')::integer,(member->>'active_request_id')::uuid,'live_source');
 PERFORM pg_temp.mixed_check(again->'replayed'='true'::jsonb AND again->>'request_id'=member->>'active_request_id','first original RPC lost reply replays exact UUID');
 END LOOP;
 PERFORM pg_temp.mixed_check((SELECT count(*) FROM public.tournament_seat_move_receipts WHERE tournament_id='b7200000-0000-4000-8000-000000000004')=old_count+1,'original move has one effect');
 state:=public.fn_f06_claim_custody('b7200000-0000-4000-8000-000000000004','b7500000-0000-4000-8000-000000000099',(state->>'break_id')::uuid,(state->>'custody_id')::uuid,(state->>'revision')::bigint);
 state:=public.fn_f06_close_break('b7200000-0000-4000-8000-000000000004','b7500000-0000-4000-8000-000000000099',(state->>'break_id')::uuid);
 state:=public.fn_f06_ack_cleanup('b7200000-0000-4000-8000-000000000004','b7500000-0000-4000-8000-000000000099',(state->>'break_id')::uuid,(state->>'custody_id')::uuid,(state->>'revision')::bigint,'retired');
 PERFORM pg_temp.mixed_check(state->>'state'='acknowledged','canonical close and ACK retain original custody UUID');
 done:=public.fn_f06_complete_mixed_manager_custody('b7200000-0000-4000-8000-000000000004','b7500000-0000-4000-8000-000000000099','b7600000-0000-4000-8000-000000000099',prepared->'receipt');
 again:=public.fn_f06_complete_mixed_manager_custody('b7200000-0000-4000-8000-000000000004','b7500000-0000-4000-8000-000000000099','b7600000-0000-4000-8000-000000000099',prepared->'receipt');
 PERFORM pg_temp.mixed_check(done=again AND (SELECT count(*) FROM smarter_private.f06_manager_custody_completions)=1,'terminal completion replay is immutable');
 PERFORM pg_temp.mixed_check(jsonb_array_length(done#>'{completion,presence_receipts}')=1 AND
 done#>'{completion,presence_receipts,0,bank,unlimitedActivations}'='true'::jsonb AND
 done#>>'{completion,presence_receipts,0,bank,remainingSeconds}'='47' AND
 EXISTS(SELECT 1 FROM public.engine_presence_parked ep JOIN public.table_seats s ON s.table_id=ep.table_id AND s.left_at IS NULL
 WHERE ep.table_id='b7300000-0000-4000-8000-000000000006' AND ep.time_bank_snapshot#>>ARRAY['players',s.user_id::text,'occupancyId']=s.occupancy_id::text
 AND ep.parked_at=(prepared#>>'{local,engines,0,bank_custody,durable_presence,parked_at}')::timestamptz AND ep.time_bank_snapshot#>ARRAY['players',s.user_id::text,'unlimitedActivations']='true'::jsonb),'native bank is adopted at exact winning destination occupancy');
 PERFORM pg_temp.mixed_check(smarter_private.f06_mixed_movement_generation((state->>'break_id')::uuid) IS NULL,'completed transfer grants no movement capability');

 PERFORM set_config('app.smarter_data_actor','service',true);
 PERFORM pg_temp.mixed_check(public.fn_f06_find_mixed_manager_custody('b7200000-0000-4000-8000-000000000004')->'receipt'='null'::jsonb,'completed history does not block ordinary discovery');
 PERFORM public.release_tournament_leases_v2('mixed-custody-successor',jsonb_build_array(jsonb_build_object('tournament_id','b7200000-0000-4000-8000-000000000004','lease_generation','b7500000-0000-4000-8000-000000000099')));
 PERFORM pg_temp.mixed_check(granted,'later ordinary restart gets genuinely new generation') FROM public.claim_tournament_lease_v2('b7200000-0000-4000-8000-000000000004','ordinary-restart','qualified','b7500000-0000-4000-8000-000000000098',30);
END $$;
DO $$ BEGIN RAISE NOTICE 'MIXED_CUSTODY_COMPLETE'; END $$;
ROLLBACK;
