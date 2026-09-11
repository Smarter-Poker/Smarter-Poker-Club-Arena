-- Two additional eliminated entrants already existed in the synthetic roster.
UPDATE public.tournament_players SET status='eliminated',position=7,eliminated_at='2026-09-10 12:20:00+00'
 WHERE tournament_id='87000000-0000-0000-0000-000000000001' AND user_id=md5('atomic-deal-user:7')::uuid;
UPDATE public.tournament_players SET status='eliminated',position=8,eliminated_at='2026-09-10 12:30:00+00'
 WHERE tournament_id='87000000-0000-0000-0000-000000000001' AND user_id=md5('atomic-deal-user:8')::uuid;
INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result,committed_at)
SELECT '87200000-0000-0000-0000-000000000001',9800000+i,md5('witness-hand:'||i)::uuid,repeat('a',64),'{}',
 CASE i WHEN 6 THEN '2026-09-10 10:20:00+00'::timestamptz WHEN 7 THEN '2026-09-10 10:30:00+00'::timestamptz
 ELSE '2026-09-10 10:10:00+00'::timestamptz END FROM generate_series(6,8) g(i);
INSERT INTO public.tournament_knockout_candidates(id,tournament_id,eliminated_user_id,table_id,seat_id,
 seat_joined_at,hand_id,hand_number,stack_before,stack_after,state,created_at,resolved_at)
SELECT md5('witness-candidate:'||i)::uuid,'87000000-0000-0000-0000-000000000001',md5('atomic-deal-user:'||i)::uuid,
 '87200000-0000-0000-0000-000000000001',md5('witness-seat:'||i)::uuid,'2026-09-10 00:00:00+00',
 md5('witness-hand:'||i)::uuid,9800000+i,i*10,0,'eliminated',
 CASE i WHEN 6 THEN '2026-09-10 10:19:00+00'::timestamptz WHEN 7 THEN '2026-09-10 10:29:00+00'::timestamptz
 ELSE '2026-09-10 10:09:00+00'::timestamptz END,'2026-09-10 12:00:00+00'
FROM generate_series(6,8) g(i);
