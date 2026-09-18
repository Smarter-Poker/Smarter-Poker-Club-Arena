SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';
-- Every synthetic transaction runs through the original accepted owner.
SELECT atomic_table_buyin_before_maintenance_announcement_gate(fixture.u(903),fixture.u(301),1,100,false,fixture.u(102),NULL);
SELECT atomic_table_buyin_before_maintenance_announcement_gate(fixture.u(904),fixture.u(301),2,100,false,fixture.u(101),NULL);
SELECT atomic_table_buyin_before_maintenance_announcement_gate(fixture.u(905),fixture.u(301),3,100,false,fixture.u(101),NULL);
SELECT fixture.assert((SELECT count(*)=3 FROM cash_participant_funding_receipts),'All original admissions retain their funding owner');
SELECT fixture.assert((SELECT count(*)=3 FROM union_pnl_original_flows),'All original chip funding records are covered');
CREATE FUNCTION fixture.place_original_transactions(p_at timestamptz) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF inet_server_addr() IS NOT NULL OR current_user<>'postgres' THEN RAISE EXCEPTION 'private native fixture only'; END IF;
 ALTER TABLE union_pnl_transaction_frames DISABLE TRIGGER original_pnl_immutable;
 ALTER TABLE union_pnl_inventory_events DISABLE TRIGGER original_pnl_inventory_events_immutable;
 ALTER TABLE union_pnl_original_flows DISABLE TRIGGER original_pnl_immutable;
 ALTER TABLE union_pnl_cash_outcomes DISABLE TRIGGER original_pnl_immutable;
 UPDATE union_pnl_transaction_frames SET observed_at=p_at,book_start=fn_union_week_start(p_at) WHERE observed_at>=fn_union_week_start(clock_timestamp());
 UPDATE union_pnl_inventory_events SET observed_at=p_at WHERE observed_at>=fn_union_week_start(clock_timestamp());
 UPDATE union_pnl_original_flows SET recognized_at=p_at WHERE recognized_at>=fn_union_week_start(clock_timestamp());
 UPDATE union_pnl_cash_outcomes SET recognized_at=p_at WHERE recognized_at>=fn_union_week_start(clock_timestamp());
 ALTER TABLE union_pnl_transaction_frames ENABLE TRIGGER original_pnl_immutable;
 ALTER TABLE union_pnl_inventory_events ENABLE TRIGGER original_pnl_inventory_events_immutable;
 ALTER TABLE union_pnl_original_flows ENABLE TRIGGER original_pnl_immutable;
 ALTER TABLE union_pnl_cash_outcomes ENABLE TRIGGER original_pnl_immutable;
END $$;
-- The fixture places real original events on an isolated historical calendar;
-- no production clock is changed and no historical balances are manufactured.
SELECT fixture.place_original_transactions('2026-09-05 12:00Z');
ALTER TABLE union_pnl_inventory_capture DISABLE TRIGGER original_pnl_inventory_capture_immutable;
ALTER TABLE union_pnl_weekly_capture DISABLE TRIGGER original_pnl_immutable;
ALTER TABLE union_pnl_eco_observations DISABLE TRIGGER original_pnl_immutable;
UPDATE union_pnl_inventory_capture SET captured_at='2026-09-04 12:00Z';
UPDATE union_pnl_weekly_capture SET captured_at='2026-09-04 12:00Z';
UPDATE union_pnl_eco_observations SET observed_from='2026-09-04 12:00Z';
UPDATE accounting_agreement_history SET observed_at=CASE WHEN event_type='baseline' THEN '2026-09-04 12:00Z'::timestamptz ELSE '2026-09-03 12:00Z'::timestamptz END WHERE entity_type='unions';
ALTER TABLE union_pnl_inventory_capture ENABLE TRIGGER original_pnl_inventory_capture_immutable;
ALTER TABLE union_pnl_weekly_capture ENABLE TRIGGER original_pnl_immutable;
ALTER TABLE union_pnl_eco_observations ENABLE TRIGGER original_pnl_immutable;
INSERT INTO engine_table_leases(table_id,instance_id,lease_generation,protocol_version,heartbeat_at)
VALUES(fixture.u(301),'weekly-native',fixture.u(601),2,clock_timestamp());
CREATE FUNCTION fixture.roster() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,'occupancy_id',s.occupancy_id,'seat_joined_at',s.joined_at,'stack_before',s.stack,'is_horse',p.is_horse) ORDER BY s.user_id)
 FROM table_seats s JOIN profiles p ON p.id=s.user_id WHERE s.table_id=fixture.u(301) AND s.left_at IS NULL;
$$;
SELECT fn_cash_capture_hand_manifest(fixture.u(301),1000701,fixture.roster(),'weekly-native',fixture.u(601));
DO $$ DECLARE stacks jsonb; result jsonb; BEGIN
 SELECT jsonb_agg(jsonb_build_object('user_id',x->'user_id','seat_id',x->'seat_id','occupancy_id',x->'occupancy_id','seat_joined_at',x->'seat_joined_at',
  'funding_manifest_id',m.id,'stack_before',x->'stack_before','stack',(x->>'stack_before')::numeric+
  CASE x->>'user_id' WHEN fixture.u(903)::text THEN 10 WHEN fixture.u(904)::text THEN -10 ELSE 0 END)) INTO stacks
 FROM cash_hand_participant_manifests m CROSS JOIN LATERAL jsonb_array_elements(m.participants) x WHERE m.hand_number=1000701;
 result:=fn_ca_commit_hand_settlement_before_lease_generation(fixture.u(301),1000701,stacks,0,0,NULL,0,jsonb_build_object('table_id',fixture.u(301),'hand_number',1000701),'[]');
 PERFORM fixture.assert(result->>'success'='true','Actual original hand commits: '||result::text);
END $$;
SELECT fixture.assert((SELECT count(*)=1 AND bool_and(evidence->>'status'='ready') FROM union_pnl_cash_outcomes),'Deferred original acceptance captures a complete certified outcome');
SELECT fixture.place_original_transactions('2026-09-10 12:00Z');
DO $$ DECLARE proof jsonb; BEGIN
 proof:=fn_union_pnl_evidence_report(fixture.u(201),'2026-09-07 07:00Z','2026-09-14 07:00Z');
 PERFORM fixture.assert(proof->>'status'='ready','Complete original cash week qualifies: '||proof::text);
 PERFORM fixture.assert((SELECT (x->>'net')::numeric=10 FROM jsonb_array_elements(proof->'clubs') x WHERE x->>'club_id'=fixture.u(102)::text),'Exact signed cash winner amount');
 PERFORM fixture.assert((SELECT (x->>'net')::numeric=-10 AND (x->>'players')::int=2 FROM jsonb_array_elements(proof->'clubs') x WHERE x->>'club_id'=fixture.u(101)::text),'Horse and zero-delta participant remain in complete losing-club population');
END $$;
