-- Synthetic opening only on the isolated full-schema fixture. The movement,
-- elimination, custody and receipt functions below are actual captured owners.
BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) VALUES('b7100000-0000-4000-8000-000000000009');
INSERT INTO public.users(id,username) VALUES('b7100000-0000-4000-8000-000000000009','movement_survivor');
INSERT INTO public.profiles(id,username,display_name) VALUES('b7100000-0000-4000-8000-000000000009','movement_survivor','Movement Survivor');
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance,membership_lifecycle_status)
VALUES('20000000-0000-0000-0000-000000000001','b7100000-0000-4000-8000-000000000009','player','active',0,'active');
INSERT INTO public.tournament_players(id,tournament_id,user_id,club_id,status,chips,table_id,seat_number,prize,current_bounty)
VALUES('b7500000-0000-4000-8000-000000000009','b7200000-0000-4000-8000-000000000004',
'b7100000-0000-4000-8000-000000000009','20000000-0000-0000-0000-000000000001','playing',100,'b7300000-0000-4000-8000-000000000004',3,0,0);
INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,joined_at,left_at,
leave_pending,is_sitting_out,is_away,club_id,active_game_scope,active_parent_key)
VALUES('b7400000-0000-4000-8000-000000000009','b7300000-0000-4000-8000-000000000004',3,
'b7100000-0000-4000-8000-000000000009',100,'active',clock_timestamp()-interval '2 minutes',NULL,false,false,false,
'20000000-0000-0000-0000-000000000001','table:b7300000-0000-4000-8000-000000000004','tournament:b7200000-0000-4000-8000-000000000004');
INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,club_id,max_players,
small_blind,big_blind,stakes,seat_game_scope,seat_admission_key)
SELECT ('b7300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Movement Destination '||n,
'b7200000-0000-4000-8000-000000000004','running','live',0,'tournament','20000000-0000-0000-0000-000000000001',9,
5,10,'5/10','table:b7300000-0000-4000-8000-'||lpad(n::text,12,'0'),'tournament:b7200000-0000-4000-8000-000000000004'
FROM generate_series(5,6) n;
UPDATE public.tables SET current_players=3 WHERE id='b7300000-0000-4000-8000-000000000004';
UPDATE public.tournaments SET current_players=3 WHERE id='b7200000-0000-4000-8000-000000000004';
UPDATE public.hand_history SET players=players||jsonb_build_array(jsonb_build_object('userId','b7100000-0000-4000-8000-000000000009','stack',100))
WHERE hand_number=9720004;
UPDATE public.hand_atomic_commits a SET stack_result=a.stack_result||jsonb_build_object(
'mode','delta','tournament_id','b7200000-0000-4000-8000-000000000004','players',3,
'conservation_checked',true,'tournament_players_synced',true,'tournament_player_count',3,
'rebased','{}'::jsonb,'departed','[]'::jsonb,'net_deltas',0,'inflow',0,'rake',0,'bbj',0,
'request',jsonb_build_object('stacks',(SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,
'seat_joined_at',s.joined_at,'stack',s.stack,'stack_before',CASE WHEN s.seat_number=1 THEN 100 WHEN s.seat_number=2 THEN 0 ELSE 100 END) ORDER BY s.user_id)
FROM public.table_seats s WHERE s.table_id=a.table_id)),
'written',(SELECT jsonb_object_agg(s.user_id,s.stack) FROM public.table_seats s WHERE s.table_id=a.table_id),
'tournament_player_chips',(SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'chips',s.stack) ORDER BY s.user_id) FROM public.table_seats s WHERE s.table_id=a.table_id)),
post_commit_payload=jsonb_build_object('version',1,'rake',NULL,'insurance','[]'::jsonb,'time_banks','[]'::jsonb,
'pending_addons',NULL,'bbj_contribution',NULL,'promo_playthrough','[]'::jsonb,
'accepted_hand_facts',jsonb_build_object('insurance','[]'::jsonb,'contributions',jsonb_build_object('b7100000-0000-4000-8000-000000000007',100),'returned_uncalled','{}'::jsonb)),
post_commit_result=jsonb_build_object('ok',true,'hand_id',a.hand_id,'hand_number',a.hand_number),
post_commit_completed_at=a.committed_at+interval '1 second'
WHERE a.hand_number=9720004;
UPDATE public.hand_atomic_commits a SET
post_commit_payload_hash=encode(extensions.digest(convert_to(post_commit_payload::text,'UTF8'),'sha256'),'hex'),
post_commit_request_hash=encode(extensions.digest(convert_to((post_commit_payload-'accepted_hand_facts')::text,'UTF8'),'sha256'),'hex')
WHERE a.hand_number=9720004;
UPDATE public.settlement_idempotency_keys k SET result=a.stack_result FROM public.hand_atomic_commits a
WHERE a.hand_number=9720004 AND k.table_id=a.table_id AND k.hand_id=(a.stack_result->>'hand_id')::uuid;
SET LOCAL session_replication_role=origin;
COMMIT;
