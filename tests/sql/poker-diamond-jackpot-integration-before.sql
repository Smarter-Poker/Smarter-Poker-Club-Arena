-- Synthetic submissions; every financial and accepted-hand writer is real.
UPDATE ca_arena_settings SET cash_games_enabled=true;
UPDATE tables SET small_blind=1,big_blind=2,game_type='cash',status='running',
 min_buy_in=2,max_buy_in=2000,rake_percent=0,rake_cap_bb=0,bbj_percent=0,
 run_it_twice=false,allow_run_it_twice=false;
-- A new synthetic table is funded only through the real reservation writer.
-- Baseline mint rows declare the fixture's initial profile balances; they are
-- not a production mint or a replacement settlement/payout implementation.
INSERT INTO tables(id,club_id,union_id,tournament_id,game_type,game_variant,status,
 small_blind,big_blind,min_buy_in,max_buy_in,rake_percent,rake_cap_bb,bbj_percent,
 run_it_twice,allow_run_it_twice)
 VALUES('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001',
 NULL,NULL,'cash','nlh','running',5000,10000,10000,1000000,0,0,0,false,false);
DO $$ DECLARE u uuid; r jsonb; i integer;
BEGIN FOR i IN 1..4 LOOP
 u:=('11000000-0000-0000-0000-00000000000'||i)::uuid;
 INSERT INTO profiles(id,diamonds,is_horse,username) VALUES(u,500000,i=4,'fixture_'||i);
 INSERT INTO diamond_purchase_lots(user_id,issued,created_at) VALUES(u,500000,now()-interval '30 days');
 INSERT INTO ca_mint_ledger(op_id,action,asset,holder_type,holder_id,amount,reason)
 VALUES('fixture:integration:baseline:'||u,'mint','diamonds','player',u,500000,'synthetic profile baseline');
 r:=fn_poker_diamond_reserve(u,'cash_seat','30000000-0000-0000-0000-000000000002',
 'fixture:integration:seat:'||u,200000,('41000000-0000-0000-0000-00000000000'||i)::uuid);
 INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,joined_at,club_id)
 VALUES((r->>'custody_id')::uuid,'30000000-0000-0000-0000-000000000002',u,i,200000,
 '2026-10-12T01:00:00Z','20000000-0000-0000-0000-000000000001');
 UPDATE poker_diamond_custody c SET state='active',seat_id=s.id,
 seat_joined_at=s.joined_at,occupancy_id=s.occupancy_id FROM table_seats s
 WHERE c.id=(r->>'custody_id')::uuid AND c.id=s.id;
 END LOOP; END $$;
INSERT INTO engine_table_leases(table_id,instance_id,lease_generation,protocol_version,heartbeat_at)
 VALUES('30000000-0000-0000-0000-000000000002','fixture-jackpot',
 '90000000-0000-0000-0000-000000000001',2,clock_timestamp());
CREATE FUNCTION fixture_jackpot_request(h bigint,drop_amount numeric DEFAULT 0,
 saw_flop boolean DEFAULT true,double_board boolean DEFAULT false,kind text DEFAULT 'none',rake_fee numeric DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE stacks jsonb; banks jsonb; contributions jsonb; ids jsonb; players jsonb; cards jsonb; row jsonb; obligations jsonb;
BEGIN
 SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,
 'seat_joined_at',s.joined_at,'stack_before',s.stack,
 'stack',s.stack-CASE WHEN s.seat_number=1 THEN drop_amount+rake_fee ELSE 0 END,
 'contributed',100000,'dealt_in',true,'hand_saw_flop',saw_flop,
 'hand_double_board',double_board) ORDER BY s.user_id),
 jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,
 'seat_joined_at',s.joined_at,'uses_remaining',0,'seconds_remaining',0) ORDER BY s.user_id),
 jsonb_object_agg(s.user_id,100000),jsonb_agg(s.user_id ORDER BY s.user_id)
 INTO stacks,banks,contributions,ids FROM table_seats s WHERE s.left_at IS NULL AND s.table_id='30000000-0000-0000-0000-000000000002';
 SELECT jsonb_agg(jsonb_build_object('userId',s.user_id,'seat',s.seat_number,'stack',s.stack) ORDER BY s.user_id),
 jsonb_object_agg(s.user_id,jsonb_build_array('Aspades','Adiamonds')) INTO players,cards
 FROM table_seats s WHERE s.table_id='30000000-0000-0000-0000-000000000002' AND s.left_at IS NULL;
 row:=jsonb_build_object('table_id','30000000-0000-0000-0000-000000000002',
 'hand_number',h,'game_variant','nlh','tournament_id',NULL,'pot_size',400000,'big_blind',10000,
 'players',players,'hole_cards',cards,'has_human',true,
 'showdown',jsonb_build_array(jsonb_build_object('user_id',ids->0,'mucked',false),
 jsonb_build_object('user_id',ids->1,'mucked',false),jsonb_build_object('user_id',ids->2,'mucked',true)),
 '_accepted_post_commit_facts',jsonb_build_object('contributions',contributions,
 'returned_uncalled','{}'::jsonb,'insurance','[]'::jsonb,
 'diamond_jackpot',jsonb_build_object('version',1,'kind',kind,'pot',400000,'dealt',4,
 'saw_flop',saw_flop,'double_board',double_board,'variant','nlh','big_blind',10000,
 'dealt_user_ids',ids,'loser_user_id',ids->0,'winner_user_id',ids->1,
 'loser_hand','Four of a Kind','winner_hand','Straight Flush')));
 obligations:=jsonb_build_object('version',1,'time_banks',banks,
 'promo_playthrough','[]'::jsonb,'insurance','[]'::jsonb,'pending_addons',NULL,
 'rake',NULL,'bbj_contribution',NULL);
 RETURN jsonb_build_object('stacks',stacks,'row',row,'obligations',obligations);
END $$;
CREATE FUNCTION fixture_jackpot_commit(h bigint,drop_amount numeric DEFAULT 0,
 saw_flop boolean DEFAULT true,double_board boolean DEFAULT false,kind text DEFAULT 'none',rake_fee numeric DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE q jsonb:=fixture_jackpot_request(h,drop_amount,saw_flop,double_board,kind,rake_fee);
BEGIN
 RETURN fn_ca_commit_hand_settlement('30000000-0000-0000-0000-000000000002',h,
 q->'stacks',rake_fee,drop_amount,NULL,0,q->'row','[]'::jsonb,'fixture-jackpot',
 '90000000-0000-0000-0000-000000000001',q->'obligations');
END $$;
-- Prior public wrapper refuses a Diamond jackpot verdict before any money moves.
BEGIN;
INSERT INTO ca_diamond_economics(name,scope,value_text,units,approved_quote,approved_on,basis,recorded_by)
 VALUES('bbj_enabled','all','yes','boolean','synthetic baseline activation',CURRENT_DATE,'private fail-before transaction','fixture');
CREATE TEMP TABLE fixture_before_refusal AS SELECT fixture_jackpot_commit(1100001,300) AS receipt;
SELECT fixture_assert((SELECT receipt->>'success'='false' AND receipt::text LIKE '%diamond%' FROM fixture_before_refusal),'old accepted-hand authority refuses the Diamond jackpot');
SELECT fixture_assert(NOT EXISTS(SELECT 1 FROM hand_atomic_commits WHERE hand_number=1100001),'old failure retained no accepted commit');

ROLLBACK; -- restores the mandatory closed switch before compatibility installation
