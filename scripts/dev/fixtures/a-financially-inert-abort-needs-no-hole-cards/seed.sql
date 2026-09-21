-- Two worlds, one per function under repair, each built so that EVERY
-- assertion other than the hole-card count already passes. A scenario changes
-- one thing and asks what each function now does.
--
--   World A  reaches smarter_private.f06_retired_origin_snapshot: no lease
--            row, so public.fn_f06_abort_retained_mtt_hands delegates here.
--            Its ids are the retired-origin cohort's, because
--            smarter_private.f06_retired_origin_cohort(uuid) is IMMUTABLE and
--            the branch is unreachable under any other id.
--   World B  reaches smarter_private.f06_retained_mtt_abort_snapshot: a stale
--            protocol-2 lease, so that function runs its own path to the end.
--
-- Every user, chip, stack and card value below is invented for this probe.
\set ON_ERROR_STOP on

INSERT INTO public.engine_leader(id,instance_id,engine_version,acquired_at,heartbeat_at)
VALUES (true,'1-3846b8bb','8825af51',now()-interval '1 hour',now());

-- ---------------------------------------------------------------- World A
INSERT INTO public.tournaments(id,status,format_contract)
VALUES ('5a387a75-754a-416e-8fee-b85b15fc2702','RUNNING','mtt-v2');
INSERT INTO public.tables(id,tournament_id,status,is_deleted,f06_lifecycle)
VALUES ('2c621856-e728-4e8b-bf08-4c56746a8649','5a387a75-754a-416e-8fee-b85b15fc2702','running',false,283878);
INSERT INTO public.tournament_players(id,tournament_id,user_id,chips,status,table_id,seat_number) VALUES
 ('aaaa0001-0000-4000-8000-000000000001','5a387a75-754a-416e-8fee-b85b15fc2702','aaaa1111-0000-4000-8000-000000000001',40000,'playing','2c621856-e728-4e8b-bf08-4c56746a8649',1),
 ('aaaa0002-0000-4000-8000-000000000002','5a387a75-754a-416e-8fee-b85b15fc2702','aaaa1111-0000-4000-8000-000000000002',60000,'playing','2c621856-e728-4e8b-bf08-4c56746a8649',3);
INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,joined_at,left_at,occupancy_id) VALUES
 ('aaaa0003-0000-4000-8000-000000000001','2c621856-e728-4e8b-bf08-4c56746a8649',1,'aaaa1111-0000-4000-8000-000000000001',40000,now()-interval '2 hours',NULL,'aaaa0005-0000-4000-8000-000000000001'),
 ('aaaa0003-0000-4000-8000-000000000002','2c621856-e728-4e8b-bf08-4c56746a8649',3,'aaaa1111-0000-4000-8000-000000000002',60000,now()-interval '2 hours',NULL,'aaaa0005-0000-4000-8000-000000000002');
-- The interrupted hand: preflop, nothing acted, and the 75000 "pot" exists
-- only here. 0+40000=40000 and 25000+35000=60000 are already the durable
-- chips, which is what makes the abort financially inert.
INSERT INTO public.hand_state_snapshots(id,table_id,hand_number,state_json,stage,is_complete)
VALUES ('aaaa0004-0000-4000-8000-000000000001','2c621856-e728-4e8b-bf08-4c56746a8649',12942021,
 '{"stage":"preflop","actionHistory":[],"pot":75000,
   "players":[{"user_id":"aaaa1111-0000-4000-8000-000000000001","seat":1,"stack":0,"totalInvested":40000},
              {"user_id":"aaaa1111-0000-4000-8000-000000000002","seat":3,"stack":25000,"totalInvested":35000}]}'::jsonb,
 'preflop',false);
INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state,evidence_id)
VALUES ('098c0945-54f9-4c48-a600-3b8845da267b','5a387a75-754a-416e-8fee-b85b15fc2702','2c621856-e728-4e8b-bf08-4c56746a8649',
        283878,12942021,'37815b8d-668b-472d-bc0c-3c5ae0da55b3','66291622-e7d1-4816-8c33-26ff1f092446','reserved',NULL);

-- ---------------------------------------------------------------- World B
INSERT INTO public.tournaments(id,status,format_contract)
VALUES ('bbbb0000-0000-4000-8000-00000000000b','RUNNING','mtt-v1');
INSERT INTO public.tables(id,tournament_id,status,is_deleted,f06_lifecycle)
VALUES ('bbbb1111-0000-4000-8000-00000000000b','bbbb0000-0000-4000-8000-00000000000b','waiting',false,777);
INSERT INTO public.tournament_players(id,tournament_id,user_id,chips,status,table_id,seat_number) VALUES
 ('bbbb0001-0000-4000-8000-000000000001','bbbb0000-0000-4000-8000-00000000000b','bbbb2222-0000-4000-8000-000000000001',40000,'playing','bbbb1111-0000-4000-8000-00000000000b',1),
 ('bbbb0002-0000-4000-8000-000000000002','bbbb0000-0000-4000-8000-00000000000b','bbbb2222-0000-4000-8000-000000000002',60000,'playing','bbbb1111-0000-4000-8000-00000000000b',3);
INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,joined_at,left_at,occupancy_id) VALUES
 ('bbbb0003-0000-4000-8000-000000000001','bbbb1111-0000-4000-8000-00000000000b',1,'bbbb2222-0000-4000-8000-000000000001',40000,now()-interval '2 hours',NULL,'bbbb0005-0000-4000-8000-000000000001'),
 ('bbbb0003-0000-4000-8000-000000000002','bbbb1111-0000-4000-8000-00000000000b',3,'bbbb2222-0000-4000-8000-000000000002',60000,now()-interval '2 hours',NULL,'bbbb0005-0000-4000-8000-000000000002');
INSERT INTO public.hand_state_snapshots(id,table_id,hand_number,state_json,stage,is_complete)
VALUES ('bbbb0004-0000-4000-8000-000000000001','bbbb1111-0000-4000-8000-00000000000b',900001,
 '{"stage":"preflop","actionHistory":[],"pot":75000,
   "players":[{"user_id":"bbbb2222-0000-4000-8000-000000000001","seat":1,"stack":0,"totalInvested":40000},
              {"user_id":"bbbb2222-0000-4000-8000-000000000002","seat":3,"stack":25000,"totalInvested":35000}]}'::jsonb,
 'preflop',false);
INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state,evidence_id)
VALUES ('bbbb6666-0000-4000-8000-00000000000b','bbbb0000-0000-4000-8000-00000000000b','bbbb1111-0000-4000-8000-00000000000b',
        777,900001,'bbbb7777-0000-4000-8000-00000000000b','bbbb3333-0000-4000-8000-00000000000b','reserved',NULL);
-- Stale by the live 30s rule, protocol 2, matching generation.
INSERT INTO public.engine_tournament_leases(tournament_id,instance_id,engine_version,acquired_at,heartbeat_at,lease_generation,protocol_version)
VALUES ('bbbb0000-0000-4000-8000-00000000000b','probe-instance','probe-engine',
        now()-interval '2 hours', now()-interval '10 minutes','bbbb3333-0000-4000-8000-00000000000b',2);
