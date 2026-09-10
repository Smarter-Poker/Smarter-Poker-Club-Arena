-- All rows are synthetic and seeded before enabling the actual trigger graph.
CREATE FUNCTION public.test_id(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$f$;
INSERT INTO ca_financial_epochs(name,is_current) VALUES('native-source',true);
INSERT INTO auth.users(id) SELECT test_id(n) FROM unnest(ARRAY[100,201,202,301,302,303]) n;
INSERT INTO profiles(id,username) SELECT test_id(n),'native-source-'||n FROM unnest(ARRAY[100,201,202,301,302,303]) n;
INSERT INTO clubs(id,name,owner_id,asset,is_platform,chip_pool,chip_treasury)
VALUES(test_id(900),'Native Source Club',test_id(100),'chips',false,10000,10000);
INSERT INTO agents(id,user_id,club_id,role,commission_rate,player_rakeback_rate,parent_agent_id,agent_wallet_balance,business_balance)
VALUES(test_id(101),test_id(301),test_id(900),'super_agent',.70,.10,NULL,100,100),
(test_id(102),test_id(302),test_id(900),'agent',.50,.10,test_id(101),100,100),
(test_id(103),test_id(303),test_id(900),'sub_agent',.30,.10,test_id(102),100,100);
INSERT INTO club_members(club_id,user_id,role,agent_id,player_rakeback_pct,chip_balance,status,is_bot)
VALUES(test_id(900),test_id(100),'owner',NULL,0,0,'active',false),
(test_id(900),test_id(201),'player',test_id(303),.10,100,'active',false),
(test_id(900),test_id(202),'player',test_id(303),.10,100,'active',false);
INSERT INTO tables(id,club_id,name,game_type,game_variant,small_blind,big_blind,status,lifecycle,seat_game_scope,seat_admission_key)
VALUES(test_id(950),test_id(900),'Native Source Table','cash',NULL,1,2,'running','live','table:'||test_id(950)::text,'cash');
INSERT INTO table_seats(id,table_id,seat_number,user_id,club_id,stack,joined_at,status,active_game_scope,active_parent_key)
VALUES(test_id(701),test_id(950),1,test_id(201),test_id(900),1000,'2026-09-10 00:00:00Z','playing','table:'||test_id(950)::text,'cash'),
(test_id(702),test_id(950),2,test_id(202),test_id(900),1000,'2026-09-10 00:00:00Z','playing','table:'||test_id(950)::text,'cash');
INSERT INTO engine_table_leases(table_id,instance_id,engine_version,lease_generation,protocol_version)
VALUES(test_id(950),'native-owner-source','proof',test_id(960),2);
CREATE TABLE public.test_checks(name text PRIMARY KEY,passed boolean NOT NULL);
CREATE FUNCTION public.test_assert(p_name text,p_pass boolean) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN IF p_pass IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAILED: %',p_name; END IF;
INSERT INTO test_checks VALUES(p_name,true); END $f$;
