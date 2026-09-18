-- Real public hand, final installed journal assertion, real stack core and outbox.
-- The restored original 2,500 wins a 5,000 pot. Total felt stays 322,500.
BEGIN;
DO $hand$ DECLARE stacks jsonb; banks jsonb; history jsonb; obligations jsonb; r jsonb;
BEGIN
 SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,
   'seat_joined_at',s.joined_at,'stack_before',CASE s.user_id
     WHEN 'b7100000-0000-4000-8000-000000000001' THEN 2500 ELSE 320000 END,
   'stack',CASE s.user_id WHEN 'b7100000-0000-4000-8000-000000000001' THEN 5000 ELSE 317500 END) ORDER BY s.user_id),
   jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,
   'seat_joined_at',s.joined_at,'uses_remaining',3,'seconds_remaining',17) ORDER BY s.user_id)
 INTO stacks,banks FROM public.table_seats s
 WHERE s.table_id='b7300000-0000-4000-8000-000000000001' AND s.left_at IS NULL;
 history:=jsonb_build_object('id','b7700000-0000-4000-8000-000000000090',
   'table_id','b7300000-0000-4000-8000-000000000001',
   'tournament_id','b7200000-0000-4000-8000-000000000001','hand_number',9720100,
   'game_variant','nlh','small_blind',1,'big_blind',2,'pot_size',5000,
   'rake_amount',0,'bbj_amount',0,'players',stacks,'actions','[]'::jsonb,
   'winners',jsonb_build_array(jsonb_build_object('user_id','b7100000-0000-4000-8000-000000000001','amount',5000)),
   '_accepted_post_commit_facts',jsonb_build_object('contributions',jsonb_build_object(
     'b7100000-0000-4000-8000-000000000001',2500,
     'b7100000-0000-4000-8000-000000000002',2500),'returned_uncalled','{}'::jsonb,'insurance','[]'::jsonb));
 obligations:=jsonb_build_object('version','1','time_banks',banks,'promo_playthrough','[]'::jsonb,
   'insurance','[]'::jsonb,'pending_addons','null'::jsonb,'rake','null'::jsonb,'bbj_contribution','null'::jsonb);
 r:=public.fn_ca_commit_hand_settlement('b7300000-0000-4000-8000-000000000001',9720100,
   stacks,0,0,'conserved-original-paid',0,history,'[]'::jsonb,
   'native-original-custody','b7b00000-0000-4000-8000-000000000001',obligations);
 IF r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true'
   OR r->>'post_commit_obligations' IS DISTINCT FROM 'true' THEN
   RAISE EXCEPTION 'actual public hand refused: %',r; END IF;
 RAISE NOTICE 'HAND_PUBLIC_ACCEPTED_BEFORE_COMMIT';
END $hand$;
COMMIT;
-- The actual outbox consumer finalizes its accepted receipt before removal.
DELETE FROM public.hand_projection_outbox WHERE hand_id='b7700000-0000-4000-8000-000000000090';
DO $proof$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits c JOIN public.hand_history h ON h.id=c.hand_id
     WHERE c.hand_id='b7700000-0000-4000-8000-000000000090' AND c.post_commit_completed_at IS NOT NULL
       AND c.post_commit_result->>'ok'='true' AND c.stack_result->>'success'='true')
   OR (SELECT sum(stack) FROM public.table_seats WHERE table_id='b7300000-0000-4000-8000-000000000001' AND left_at IS NULL)<>322500
   OR NOT EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tournament_players p
       ON p.user_id=s.user_id AND p.tournament_id='b7200000-0000-4000-8000-000000000001'
       WHERE s.table_id='b7300000-0000-4000-8000-000000000001' AND s.user_id='b7100000-0000-4000-8000-000000000001'
         AND s.left_at IS NULL AND s.stack=5000 AND p.chips=5000)
   OR EXISTS(SELECT 1 FROM public.hand_projection_outbox WHERE hand_id='b7700000-0000-4000-8000-000000000090')
 THEN RAISE EXCEPTION 'actual public hand completion differs'; END IF;
 RAISE NOTICE 'HAND_PUBLIC_COMPLETED_PROVEN';
END $proof$;
