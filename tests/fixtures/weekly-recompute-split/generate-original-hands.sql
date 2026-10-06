SET search_path=fixture_clock,public,pg_catalog,pg_temp;
CREATE FUNCTION fixture.generate_original_hands(first_hand bigint, count_hands int) RETURNS void LANGUAGE plpgsql AS $$
DECLARE n bigint; roster jsonb; stacks jsonb; result jsonb; rr uuid; h uuid;
BEGIN
 IF inet_server_addr() IS NOT NULL OR current_user<>'postgres' THEN RAISE EXCEPTION 'private native fixture only'; END IF;
 FOR n IN first_hand..first_hand+count_hands-1 LOOP
 SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,'occupancy_id',s.occupancy_id,'seat_joined_at',s.joined_at,'stack_before',s.stack,'is_horse',p.is_horse) ORDER BY s.user_id) INTO roster FROM table_seats s JOIN profiles p ON p.id=s.user_id WHERE s.table_id=fixture.u(305) AND s.left_at IS NULL;
 PERFORM fn_cash_capture_hand_manifest(fixture.u(305),n,roster,'weekly-raked-native',fixture.u(602));
 SELECT jsonb_agg(jsonb_build_object('user_id',x->'user_id','seat_id',x->'seat_id','occupancy_id',x->'occupancy_id','seat_joined_at',x->'seat_joined_at','funding_manifest_id',m.id,'stack_before',x->'stack_before','stack',(x->>'stack_before')::numeric-0.01)) INTO stacks FROM cash_hand_participant_manifests m CROSS JOIN LATERAL jsonb_array_elements(m.participants) x WHERE m.table_id=fixture.u(305) AND m.hand_number=n;
 result:=fn_ca_commit_hand_settlement_before_lease_generation(fixture.u(305),n,stacks,0.02,0,NULL,0,jsonb_build_object('table_id',fixture.u(305),'hand_number',n,'started_at',clock_timestamp()),'[]');
 IF result->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'hand refused %',result; END IF;
 SELECT hand_id INTO h FROM hand_atomic_commits WHERE table_id=fixture.u(305) AND hand_number=n;
 SELECT rake_record_id INTO rr FROM atomic_distribute_rake(fixture.u(305),fixture.u(203),h,n,0.02,0,100,2,jsonb_build_object(fixture.u(907)::text,50,fixture.u(908)::text,50),NULL,NULL,'WEIGHTED_CONTRIBUTED');
 result:=fn_process_cash_accounting_source(rr);
 IF result->>'status' IS DISTINCT FROM 'accrued' THEN RAISE EXCEPTION 'source refused %',result; END IF;
 END LOOP;
END $$;
