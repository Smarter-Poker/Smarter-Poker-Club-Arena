-- Synthetic boundaries modelled on 85313174 "Coffee Break Freeroll (PLO4)"
-- (2026-10-16). Table A: an add-on bought while the last hand was dealt, so
-- the settlement rebased the seat. Table B: a player busted in the hand
-- before, rebought, and re-seated in the same chair while the last hand was
-- dealt. Table C: an ordinary park with no receipts at all.
CREATE FUNCTION pg_temp.u(t text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5(t)::uuid $$;
CREATE FUNCTION pg_temp.h(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT encode(extensions.digest(convert_to(p::text,'UTF8'),'sha256'),'hex') $$;

INSERT INTO public.tournaments VALUES (pg_temp.u('X'),'RUNNING',3000,3000,3000);
INSERT INTO public.tables VALUES (pg_temp.u('A'),pg_temp.u('X'),7,'running',false),(pg_temp.u('B'),pg_temp.u('X'),9,'running',false),(pg_temp.u('C'),pg_temp.u('X'),11,'running',false);
INSERT INTO smarter_private.f06_operations VALUES (pg_temp.u('breakA'),pg_temp.u('X'),pg_temp.u('A'),7,'park_requested',NULL),
 (pg_temp.u('breakB'),pg_temp.u('X'),pg_temp.u('B'),9,'park_requested',NULL),(pg_temp.u('breakC'),pg_temp.u('X'),pg_temp.u('C'),11,'park_requested',NULL);

CREATE FUNCTION pg_temp.hand(tb text, n bigint, at timestamptz, sr jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE payload jsonb:='{"version":"1","accepted_hand_facts":{}}'; id uuid:=pg_temp.u(tb||':'||n);
BEGIN
 INSERT INTO public.hand_atomic_commits VALUES (id,pg_temp.u(tb),n,at,repeat('a',64),
  sr||jsonb_build_object('success',true,'mode','delta','table_id',pg_temp.u(tb),'tournament_id',pg_temp.u('X'),'hand_number',n,
   'hand_id',pg_temp.u('stack:'||tb||':'||n),'conservation_checked',true,'tournament_players_synced',true,'departed','[]'::jsonb,
   'net_deltas',0,'inflow',0,'rake',0,'bbj',0,'players',jsonb_array_length(sr#>'{request,stacks}'),
   'tournament_player_count',jsonb_array_length(sr#>'{request,stacks}')),
  payload,pg_temp.h(payload),pg_temp.h(payload-'accepted_hand_facts'),at+interval '1 second',
  jsonb_build_object('ok',true,'hand_id',id,'hand_number',n));
 INSERT INTO public.hand_history VALUES (id,pg_temp.u(tb),n,at);
END $$;

-- Table A ------------------------------------------------------------------
SELECT pg_temp.hand('A',100,'2026-10-16 17:02:04+00',jsonb_build_object('rebased','{}'::jsonb,
 'request',jsonb_build_object('stacks',jsonb_build_array(
   jsonb_build_object('user_id',pg_temp.u('U1'),'seat_id',pg_temp.u('S1'),'seat_joined_at','2026-10-16T16:44:27+00:00','stack',6776,'stack_before',6800),
   jsonb_build_object('user_id',pg_temp.u('U2'),'seat_id',pg_temp.u('S2'),'seat_joined_at','2026-10-16T16:45:06+00:00','stack',1000,'stack_before',976)))));
SELECT pg_temp.hand('A',101,'2026-10-16 17:02:58+00',jsonb_build_object(
 'rebased',jsonb_build_object(pg_temp.u('U1'),3000),
 'request',jsonb_build_object('stacks',jsonb_build_array(
   jsonb_build_object('user_id',pg_temp.u('U1'),'seat_id',pg_temp.u('S1'),'seat_joined_at','2026-10-16T16:44:27+00:00','stack',6626,'stack_before',6776),
   jsonb_build_object('user_id',pg_temp.u('U2'),'seat_id',pg_temp.u('S2'),'seat_joined_at','2026-10-16T16:45:06+00:00','stack',1150,'stack_before',1000))),
 'written',jsonb_build_object(pg_temp.u('U1'),9626,pg_temp.u('U2'),1150),
 'tournament_player_chips',jsonb_build_array(jsonb_build_object('user_id',pg_temp.u('U1'),'chips',9626),jsonb_build_object('user_id',pg_temp.u('U2'),'chips',1150))));
INSERT INTO public.ca_seat_stack_rebases VALUES (1,pg_temp.u('settleA'),pg_temp.u('A'),pg_temp.u('stack:A:101'),101,pg_temp.u('U1'),6776,9776,6626,9626,3000,'2026-10-16 17:02:58+00');
INSERT INTO public.tournament_participant_funding_receipts VALUES
 (pg_temp.u('fU1entry'),pg_temp.u('X'),pg_temp.u('U1'),pg_temp.u('rU1'),'entry','2026-10-16 15:44:27+00',NULL,NULL,'{"addon_chips":3000,"starting_chips":3000,"rebuy_chips":3000}','{"chips":0,"status":"registered"}'),
 (pg_temp.u('fU1addon'),pg_temp.u('X'),pg_temp.u('U1'),pg_temp.u('rU1'),'addon','2026-10-16 17:02:49+00','tourney:addon:U1',pg_temp.u('lU1addon'),
  '{"addon_chips":3000,"starting_chips":3000,"rebuy_chips":3000}',jsonb_build_object('table_id',pg_temp.u('A'),'seat_number',2,'status','playing','chips',9776,'add_on',true));
INSERT INTO public.table_seats VALUES (pg_temp.u('S1'),pg_temp.u('A'),pg_temp.u('U1'),2,9626,'2026-10-16 16:44:27+00',NULL,pg_temp.u('oS1')),
 (pg_temp.u('S2'),pg_temp.u('A'),pg_temp.u('U2'),3,1150,'2026-10-16 16:45:06+00',NULL,pg_temp.u('oS2'));
INSERT INTO public.tournament_players VALUES (pg_temp.u('rU1'),pg_temp.u('X'),pg_temp.u('U1'),9626,'playing',NULL,pg_temp.u('A'),2,true,0),
 (pg_temp.u('rU2'),pg_temp.u('X'),pg_temp.u('U2'),1150,'playing',NULL,pg_temp.u('A'),3,false,0);

-- Table B ------------------------------------------------------------------
SELECT pg_temp.hand('B',200,'2026-10-16 17:02:38+00',jsonb_build_object('rebased','{}'::jsonb,
 'request',jsonb_build_object('stacks',jsonb_build_array(
   jsonb_build_object('user_id',pg_temp.u('U3'),'seat_id',pg_temp.u('S3'),'seat_joined_at','2026-10-16T17:01:19+00:00','stack',0,'stack_before',3451),
   jsonb_build_object('user_id',pg_temp.u('U4'),'seat_id',pg_temp.u('S4'),'seat_joined_at','2026-10-16T16:45:51+00:00','stack',4000,'stack_before',549))),
 'written',jsonb_build_object(pg_temp.u('U3'),0,pg_temp.u('U4'),4000),
 'tournament_player_chips',jsonb_build_array(jsonb_build_object('user_id',pg_temp.u('U3'),'chips',0),jsonb_build_object('user_id',pg_temp.u('U4'),'chips',4000)),
 'tournament_zero_stack_seat_generations',jsonb_build_array(jsonb_build_object('seat_id',pg_temp.u('S3'),'user_id',pg_temp.u('U3'),'joined_at','2026-10-16T17:01:19+00:00','seat_number',5))));
SELECT pg_temp.hand('B',201,'2026-10-16 17:03:22+00',jsonb_build_object('rebased','{}'::jsonb,
 'request',jsonb_build_object('stacks',jsonb_build_array(
   jsonb_build_object('user_id',pg_temp.u('U4'),'seat_id',pg_temp.u('S4'),'seat_joined_at','2026-10-16T16:45:51+00:00','stack',4500,'stack_before',4000),
   jsonb_build_object('user_id',pg_temp.u('U5'),'seat_id',pg_temp.u('S5'),'seat_joined_at','2026-10-16T16:44:22+00:00','stack',2500,'stack_before',3000))),
 'written',jsonb_build_object(pg_temp.u('U4'),4500,pg_temp.u('U5'),2500),
 'tournament_player_chips',jsonb_build_array(jsonb_build_object('user_id',pg_temp.u('U4'),'chips',4500),jsonb_build_object('user_id',pg_temp.u('U5'),'chips',2500))));
INSERT INTO public.tournament_participant_funding_receipts VALUES
 (pg_temp.u('fU3entry'),pg_temp.u('X'),pg_temp.u('U3'),pg_temp.u('rU3'),'entry','2026-10-16 15:42:35+00',NULL,NULL,'{"addon_chips":3000,"starting_chips":3000,"rebuy_chips":3000}','{"chips":0,"status":"registered"}'),
 (pg_temp.u('fU3rebuy'),pg_temp.u('X'),pg_temp.u('U3'),pg_temp.u('rU3'),'rebuy','2026-10-16 17:02:43.37+00','tourney:rebuy:U3',pg_temp.u('lU3rebuy'),
  '{"addon_chips":3000,"starting_chips":3000,"rebuy_chips":3000}',jsonb_build_object('table_id',pg_temp.u('B'),'seat_number',5,'status','playing','chips',3000,'eliminated_at',NULL));
INSERT INTO public.table_seats VALUES (pg_temp.u('S3'),pg_temp.u('B'),pg_temp.u('U3'),5,3000,'2026-10-16 17:02:43.41+00',NULL,pg_temp.u('oS3b')),
 (pg_temp.u('S4'),pg_temp.u('B'),pg_temp.u('U4'),8,4500,'2026-10-16 16:45:51+00',NULL,pg_temp.u('oS4')),
 (pg_temp.u('S5'),pg_temp.u('B'),pg_temp.u('U5'),1,2500,'2026-10-16 16:44:22+00',NULL,pg_temp.u('oS5'));
INSERT INTO public.tournament_players VALUES (pg_temp.u('rU3'),pg_temp.u('X'),pg_temp.u('U3'),3000,'playing',NULL,pg_temp.u('B'),5,false,1),
 (pg_temp.u('rU4'),pg_temp.u('X'),pg_temp.u('U4'),4500,'playing',NULL,pg_temp.u('B'),8,false,0),
 (pg_temp.u('rU5'),pg_temp.u('X'),pg_temp.u('U5'),2500,'playing',NULL,pg_temp.u('B'),1,false,0);

-- Table C ------------------------------------------------------------------
SELECT pg_temp.hand('C',300,'2026-10-16 17:03:00+00',jsonb_build_object('rebased','{}'::jsonb,
 'request',jsonb_build_object('stacks',jsonb_build_array(
   jsonb_build_object('user_id',pg_temp.u('U6'),'seat_id',pg_temp.u('S6'),'seat_joined_at','2026-10-16T16:40:00+00:00','stack',5200,'stack_before',5000),
   jsonb_build_object('user_id',pg_temp.u('U7'),'seat_id',pg_temp.u('S7'),'seat_joined_at','2026-10-16T16:40:01+00:00','stack',4800,'stack_before',5000))),
 'written',jsonb_build_object(pg_temp.u('U6'),5200,pg_temp.u('U7'),4800),
 'tournament_player_chips',jsonb_build_array(jsonb_build_object('user_id',pg_temp.u('U6'),'chips',5200),jsonb_build_object('user_id',pg_temp.u('U7'),'chips',4800))));
INSERT INTO public.table_seats VALUES (pg_temp.u('S6'),pg_temp.u('C'),pg_temp.u('U6'),1,5200,'2026-10-16 16:40:00+00',NULL,pg_temp.u('oS6')),
 (pg_temp.u('S7'),pg_temp.u('C'),pg_temp.u('U7'),2,4800,'2026-10-16 16:40:01+00',NULL,pg_temp.u('oS7'));
INSERT INTO public.tournament_players VALUES (pg_temp.u('rU6'),pg_temp.u('X'),pg_temp.u('U6'),5200,'playing',NULL,pg_temp.u('C'),1,false,0),
 (pg_temp.u('rU7'),pg_temp.u('X'),pg_temp.u('U7'),4800,'playing',NULL,pg_temp.u('C'),2,false,0);
