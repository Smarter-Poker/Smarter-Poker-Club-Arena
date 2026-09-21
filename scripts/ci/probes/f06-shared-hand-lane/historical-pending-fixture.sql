-- Historical import only. The original stamp trigger is restored before every
-- authority call; it cannot synthesize new IDs for a retained physical record.
CREATE TABLE IF NOT EXISTS engine_table_leases(table_id uuid PRIMARY KEY);
DO $$DECLARE e jsonb:=fixture_history_scope(1401)#>'{pending_arrivals,0}';t uuid:=fixture_origin_t(1401); BEGIN
 PERFORM setval('smarter_private.f06_lifecycle_seq',(e->>'lifecycle')::bigint-1,true);
 INSERT INTO tables(id,tournament_id,status,f06_lifecycle) VALUES((e->>'table_id')::uuid,t,'waiting',(e->>'lifecycle')::bigint);
 ALTER TABLE table_seats DISABLE TRIGGER zzz_stamp_seat_occupancy;
 INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,occupancy_id,joined_at)
 VALUES((e->>'seat_id')::uuid,(e->>'table_id')::uuid,(e->>'user_id')::uuid,4,45000,(e->>'occupancy_id')::uuid,(e->>'joined_at')::timestamptz);
 ALTER TABLE table_seats ENABLE TRIGGER zzz_stamp_seat_occupancy;
 INSERT INTO tournament_players VALUES(gen_random_uuid(),t,(e->>'table_id')::uuid,(e->>'user_id')::uuid,4,45000,'playing');
 INSERT INTO smarter_private.f06_operations(break_id,tournament_id,source_table_id,lifecycle,boundary_id,origin_generation,state,manifest,revision)
 VALUES((e->>'break_id')::uuid,t,(e->>'table_id')::uuid,(e->>'lifecycle')::bigint,'4f9dbe4c-2330-4284-8eba-bfcf38db6292',(e->>'origin_generation')::uuid,'begun',
 jsonb_build_array(jsonb_build_object('user_id',e->>'user_id','request_id',e->>'predecessor','occupancy_id',e->>'occupancy_id','source_seat_id',e->>'seat_id',
 'source_seat_number',4,'destination_table_id','dbd8b7ea-1a99-494f-b564-f86d412dc764','destination_seat_number',1)),0);
 INSERT INTO smarter_private.f06_members VALUES((e->>'break_id')::uuid,(e->>'user_id')::uuid,(e->>'seat_id')::uuid,4,(e->>'occupancy_id')::uuid);
 INSERT INTO smarter_private.f06_attempts(request_id,break_id,user_id,revision,destination_table_id,destination_seat_number,generation,state)
 VALUES((e->>'predecessor')::uuid,(e->>'break_id')::uuid,(e->>'user_id')::uuid,1,'dbd8b7ea-1a99-494f-b564-f86d412dc764',1,(e->>'origin_generation')::uuid,'fenced');
 INSERT INTO smarter_private.f06_attempts(request_id,break_id,user_id,revision,destination_table_id,destination_seat_number,generation,state,predecessor,amendment_id,amendment_payload)
 VALUES((e->>'request_id')::uuid,(e->>'break_id')::uuid,(e->>'user_id')::uuid,2,(e->>'destination_table_id')::uuid,2,(fixture_origin_c(1401)->>'generation')::uuid,'active',
 (e->>'predecessor')::uuid,(e->>'amendment_id')::uuid,jsonb_build_object('new',e->>'request_id','seat',2,'user',e->>'user_id','break',e->>'break_id','reason','original destination unavailable','destination',e->>'destination_table_id','predecessor',e->>'predecessor'));
END$$;
