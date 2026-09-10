-- Isolated PG17 actual owner call. No money primitive is substituted.
CREATE TABLE public.test_owner_requests(hand_number bigint PRIMARY KEY,request jsonb NOT NULL,started_at timestamptz NOT NULL DEFAULT transaction_timestamp());
CREATE FUNCTION public.test_owner(p_hand bigint) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE saved jsonb; stacks jsonb; banks jsonb; facts jsonb; row_data jsonb; obligations jsonb;
BEGIN
 UPDATE engine_table_leases SET heartbeat_at=clock_timestamp() WHERE table_id=test_id(950);
 SELECT request INTO saved FROM test_owner_requests WHERE hand_number=p_hand;
 IF FOUND THEN
  RETURN fn_ca_commit_hand_settlement(test_id(950),p_hand,saved->'stacks',2,0,'native-source:'||p_hand,0,
   saved->'row','[]'::jsonb,'native-owner-source',test_id(960),saved->'obligations');
 END IF;
 SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,
  'seat_joined_at',s.joined_at,'stack_before',s.stack,'stack',s.stack+CASE s.seat_number WHEN 1 THEN 98 ELSE -100 END) ORDER BY seat_number),
 jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,'seat_joined_at',s.joined_at,
  'uses_remaining',2,'seconds_remaining',60) ORDER BY seat_number)
 INTO stacks,banks FROM table_seats s WHERE s.table_id=test_id(950) AND s.left_at IS NULL;
 facts:=jsonb_build_object('contributions',jsonb_build_object(test_id(201)::text,100,test_id(202)::text,100),
  'returned_uncalled','{}'::jsonb,'insurance','[]'::jsonb);
 row_data:=jsonb_build_object('id',test_id(p_hand::integer),'table_id',test_id(950),'club_id',test_id(900),
  'hand_number',p_hand,'game_variant','nlh','pot_size',200,'rake_amount',2,'bbj_amount',0,
  'big_blind',2,'small_blind',1,'_accepted_post_commit_facts',facts,
  'players',jsonb_build_array(jsonb_build_object('user_id',test_id(201),'seat_number',1),
   jsonb_build_object('user_id',test_id(202),'seat_number',2)),
  'winners',jsonb_build_array(jsonb_build_object('user_id',test_id(201),'amount',198)),
  'actions','[]'::jsonb);
 obligations:=jsonb_build_object('version',1,'time_banks',banks,'promo_playthrough',
  jsonb_build_array(jsonb_build_object('club_id',test_id(900),'user_id',test_id(201),'wagered',100),
    jsonb_build_object('club_id',test_id(900),'user_id',test_id(202),'wagered',100)),
  'insurance','[]'::jsonb,'pending_addons',jsonb_build_object('enabled',true,'max_buy_in',2000),'bbj_contribution',NULL,
  'rake',jsonb_build_object('club_id',test_id(900),'amount',2,'bbj',0,'pot',200,'num_players',2,
   'contributions',facts->'contributions','returned_uncalled','{}'::jsonb,'method','WEIGHTED_CONTRIBUTED'));
 INSERT INTO test_owner_requests(hand_number,request) VALUES(p_hand,jsonb_build_object('stacks',stacks,'row',row_data,'obligations',obligations));
 RETURN fn_ca_commit_hand_settlement(test_id(950),p_hand,stacks,2,0,'native-source:'||p_hand,0,
  row_data,'[]'::jsonb,'native-owner-source',test_id(960),obligations);
END $f$;
SELECT (test_owner(1000001)->>'success')::boolean AS actual_owner_success;
SELECT test_assert('Actual installed owner accepts the full synthetic cash hand',
 EXISTS(SELECT 1 FROM hand_atomic_commits WHERE hand_number=1000001 AND post_commit_payload_hash IS NOT NULL));
