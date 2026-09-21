-- New-runtime synthetic stop; values come from the original native capture, not metadata.
INSERT INTO tournaments VALUES(md5('sb-event')::uuid,'RUNNING','mtt-v1',9,1);
INSERT INTO engine_tournament_leases VALUES(md5('sb-event')::uuid,'sb-process','aaaaa111',now()-interval '2 minutes',now()-interval '31 seconds',md5('sb-old')::uuid,2);
INSERT INTO tables(id,tournament_id,status) VALUES(md5('sb-table')::uuid,md5('sb-event')::uuid,'running');
INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,occupancy_id,joined_at) VALUES(md5('sb-seat')::uuid,md5('sb-table')::uuid,md5('sb-user')::uuid,1,1500,md5('sb-stay')::uuid,now()-interval '1 hour');
INSERT INTO tournament_players VALUES(md5('sb-reg')::uuid,md5('sb-event')::uuid,md5('sb-table')::uuid,md5('sb-user')::uuid,1,1500,'playing');
INSERT INTO hand_history(table_id,hand_number) VALUES(md5('sb-table')::uuid,12);
INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state,evidence_id) SELECT md5('sb-settled')::uuid,md5('sb-event')::uuid,t.id,t.f06_lifecycle,12,md5('sb-allocation')::uuid,md5('sb-old')::uuid,'accepted',h.id FROM tables t JOIN hand_history h ON h.table_id=t.id WHERE t.id=md5('sb-table')::uuid;
CREATE TABLE fixture_stopped_bank_input(local_proof jsonb,expected jsonb,receipt jsonb);
INSERT INTO fixture_stopped_bank_input(local_proof)
SELECT jsonb_build_object('manager_id',md5('sb-manager')::uuid,'move_owner',md5('sb-move-owner')::uuid,
'stopped_bank_owner',jsonb_build_object('kind','mtt_pre_disposal_bank_v1','instance_id','sb-process','version','aaaaa111','generation',md5('sb-old')::uuid,'tournament_id',md5('sb-event')::uuid),
'engines',jsonb_build_array(jsonb_build_object('table_id',tb.id,'engine_id',md5('sb-engine')::uuid,'lifecycle',tb.f06_lifecycle::text,'allocation_epoch',md5('sb-allocation')::uuid,'permit',NULL,
'bank_custody',jsonb_build_object('hand_number',12,'roster',jsonb_build_array(jsonb_build_array(md5('sb-user')::uuid,(SELECT occupancy_id FROM public.table_seats WHERE id=md5('sb-seat')::uuid),1,1500)),
 'time_bank_metadata',jsonb_build_array(jsonb_build_array(md5('sb-user')::uuid,jsonb_build_object('initialSeconds',80,'baseSeconds',40,'dbConsumedSeconds',33,'unlimitedActivations',true))),
 'parked_time_banks',banks,'live_time_banks','[]'::jsonb,'disconnect_states','{}'::jsonb,'durable_presence',NULL,
 'stopped_capture',jsonb_build_object('kind','mtt_pre_disposal_bank_v1','table_id',tb.id,'engine_id',md5('sb-engine')::uuid,
 'tournament_id',tb.tournament_id,'generation',md5('sb-old')::uuid,'lifecycle',tb.f06_lifecycle::text,'accounting','acknowledged',
 'snapshot',jsonb_build_object('table_id',tb.id,'parked_at',now(),'disconnect_states','{}'::jsonb,
 'time_bank_snapshot',jsonb_build_object('version',1,'parkedAt',now(),'handNumber',12,'players',banks)))))),
'retained','[]'::jsonb,'durable','[]'::jsonb,'pending_moves','[]'::jsonb,'parks','[]'::jsonb,'begins','[]'::jsonb,'amendments','[]'::jsonb,
'rejected_begins','[]'::jsonb,'resolved_proposals','[]'::jsonb,'custody_ids','[]'::jsonb,'cleanup_kinds','[]'::jsonb,'no_start','[]'::jsonb,
'stopped_originals','[]'::jsonb,'arrival_wakes','[]'::jsonb,'reservations','[]'::jsonb,'retirement',NULL)
FROM tables tb CROSS JOIN LATERAL (SELECT jsonb_build_object(md5('sb-user')::uuid::text,
jsonb_build_object('occupancyId',(SELECT occupancy_id FROM public.table_seats WHERE id=md5('sb-seat')::uuid),'remainingSeconds',7,'usesRemaining',1,'initialSeconds',80,'baseSeconds',40,'dbConsumedSeconds',33,'unlimitedActivations',true)) banks) b
WHERE tb.id=md5('sb-table')::uuid;
CREATE FUNCTION fixture_stopped_prepare(expected jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
 SELECT fn_f06_prepare_mixed_manager_custody(md5('sb-transfer')::uuid,md5('sb-event')::uuid,md5('sb-old')::uuid,md5('sb-new')::uuid,(SELECT local_proof FROM fixture_stopped_bank_input),expected) $$;
