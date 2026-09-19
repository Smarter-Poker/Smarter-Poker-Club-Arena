-- Synthetic local custody, never an attestation about the production banks.
CREATE FUNCTION fixture_origin_local(i integer) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('manager_id',fixture_origin_c(i)->>'manager_id','move_owner',md5('origin-move-owner'||i)::uuid,
 'engines',(SELECT jsonb_agg(jsonb_build_object('table_id',tab.id,'engine_id',fixture_origin_c(i)->'engines'->>tab.id::text,
 'lifecycle',tab.f06_lifecycle::text,'allocation_epoch',NULL,
 'permit',CASE WHEN tab.id=fixture_origin_table(i) THEN jsonb_build_object('phase','reserved','binding',
 fixture_origin_c(i)->'permit'||jsonb_build_object('lease_generation',fixture_origin_c(i)->>'generation')) ELSE 'null'::jsonb END,
 'bank_custody',jsonb_build_object('hand_number',CASE WHEN tab.id=fixture_origin_table(i) THEN (fixture_origin_c(i)#>>'{permit,hand_number}')::bigint ELSE 0 END,
 'roster',COALESCE((SELECT jsonb_agg(jsonb_build_array(s.user_id,s.occupancy_id,s.seat_number,s.stack) ORDER BY s.user_id) FROM table_seats s WHERE s.table_id=tab.id AND s.left_at IS NULL),'[]'),
 'time_bank_metadata','[]'::jsonb,'parked_time_banks','{}'::jsonb,'live_time_banks','[]'::jsonb,'disconnect_states','{}'::jsonb,'durable_presence',NULL)) ORDER BY tab.id)
 FROM tables tab WHERE tab.tournament_id=fixture_origin_t(i)),
 'retained',(SELECT jsonb_agg(jsonb_build_object('break_id',o.break_id,'table_id',o.source_table_id,'engine_id',fixture_origin_c(i)->'engines'->>o.source_table_id::text) ORDER BY o.break_id)
 FROM smarter_private.f06_operations o WHERE o.tournament_id=fixture_origin_t(i) AND o.state<>'acknowledged'),
 'durable',(SELECT jsonb_agg(jsonb_build_array(o.break_id,jsonb_build_object('lifecycle',o.lifecycle::text)) ORDER BY o.break_id) FROM smarter_private.f06_operations o WHERE o.tournament_id=fixture_origin_t(i)),
 'pending_moves',COALESCE((SELECT jsonb_agg(jsonb_build_array(a.request_id,jsonb_build_object('input',jsonb_build_object(
 'requestId',a.request_id,'tournamentId',o.tournament_id,'userId',a.user_id,'sourceTableId',o.source_table_id,
 'destinationTableId',a.destination_table_id,'destinationSeatNumber',a.destination_seat_number))) ORDER BY a.request_id)
 FROM smarter_private.f06_attempts a JOIN smarter_private.f06_operations o USING(break_id) WHERE o.tournament_id=fixture_origin_t(i)),'[]'),
 'parks','[]'::jsonb,'begins','[]'::jsonb,'amendments','[]'::jsonb,'rejected_begins','[]'::jsonb,'resolved_proposals','[]'::jsonb,
 'custody_ids','[]'::jsonb,'cleanup_kinds','[]'::jsonb,'no_start','[]'::jsonb,'stopped_originals','[]'::jsonb,'arrival_wakes','[]'::jsonb,
 'reservations',(SELECT jsonb_agg(jsonb_build_object('table_id',o.source_table_id,'binding',jsonb_build_array(o.tournament_id,o.break_id,o.source_table_id,
 o.lifecycle::text,o.custody_generation,o.custody_id,o.revision::text)) ORDER BY o.break_id) FROM smarter_private.f06_operations o WHERE o.tournament_id=fixture_origin_t(i) AND o.state<>'acknowledged'),
 'retirement',NULL,
 'release_checkpoint',(SELECT jsonb_build_object('kind','legacy_engine_checkpoint_8825_v1','source','8825af51817f379c4261658ca29ecc9d8d81932d',
 'instance_id','1-3846b8bb','container_id','c63b254ee71b76aa26f4d1394d96189963774310244b046bc91186e219ca3f66',
 'process_id',1,'run_id','35405450271-1','control_sha',repeat('a',40),'ownership_token',b.ownership_token,
 'phase',b.phase,'announced_at',b.announced_at,'break_started_at',b.break_started_at,'break_ends_at',b.break_ends_at,'reason',b.reason)
 FROM engine_maintenance_break b WHERE id=true))
$$;
