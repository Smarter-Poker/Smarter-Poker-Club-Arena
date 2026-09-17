\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Synthetic starting identities/credit, never a captured book.
-- Caller owns the transaction; helpers.sql must already admit the full successor.
DO $fresh$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR inet_server_addr() IS NOT NULL
  OR current_setting('session_replication_role')<>'origin'
  OR EXISTS(SELECT 1 FROM auth.users WHERE id=pg_temp.cr_id(1))
  OR EXISTS(SELECT 1 FROM public.clubs WHERE id=pg_temp.cr_id(101))
 THEN RAISE EXCEPTION 'fresh isolated credit reduction fixture required';END IF;
END$fresh$;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) SELECT pg_temp.cr_id(n) FROM generate_series(1,40)n;
INSERT INTO public.users(id,username)
 SELECT pg_temp.cr_id(n),'credit_reduction_fixture_'||n FROM generate_series(1,40)n;
INSERT INTO public.profiles(id,username,display_name)
 SELECT pg_temp.cr_id(n),'credit_reduction_fixture_'||n,'Credit Reduction Fixture '||n FROM generate_series(1,40)n;
INSERT INTO public.clubs(id,club_id,name,owner_id,chip_treasury,is_union,asset) VALUES
 (pg_temp.cr_id(101),963701,'Credit Reduction Fixture',pg_temp.cr_id(1),0,false,'chips'),
 (pg_temp.cr_id(102),963702,'Other Credit Reduction Fixture',pg_temp.cr_id(7),0,false,'chips');
INSERT INTO public.club_members(club_id,user_id,role,status,is_active,membership_lifecycle_status,chip_balance)
 SELECT pg_temp.cr_id(101),pg_temp.cr_id(n),
 CASE n WHEN 1 THEN 'owner' WHEN 3 THEN 'admin' WHEN 4 THEN 'co_owner' WHEN 5 THEN 'admin'
 WHEN 6 THEN 'player' WHEN 7 THEN 'player' WHEN 17 THEN 'super_agent' WHEN 18 THEN 'super_agent' ELSE 'agent' END,
 CASE n WHEN 5 THEN 'suspended' WHEN 4 THEN 'approved' ELSE 'active' END,n<>5,'active',0
 FROM generate_series(1,40)n;
INSERT INTO public.club_members(club_id,user_id,role,status,is_active,membership_lifecycle_status,chip_balance) VALUES
 (pg_temp.cr_id(102),pg_temp.cr_id(7),'owner','active',true,'active',0),
 (pg_temp.cr_id(102),pg_temp.cr_id(2),'agent','active',true,'active',0);
-- Main debt-bearing target, canonical no-change target, intentionally malformed
-- old funding pair, capped target, debt refusal target, and independent targets.
INSERT INTO public.agents(id,club_id,user_id,role,status,commission_rate,player_rakeback_rate,
 credit_limit,credit_used,is_prepaid,agent_wallet_balance,player_wallet_balance,promo_wallet_balance) VALUES
 (pg_temp.cr_id(201),pg_temp.cr_id(101),pg_temp.cr_id(2),'agent','active',0,0,100,25,false,0,0,0),
 (pg_temp.cr_id(202),pg_temp.cr_id(101),pg_temp.cr_id(12),'agent','active',0,0,0,0,true,0,0,0),
 (pg_temp.cr_id(203),pg_temp.cr_id(101),pg_temp.cr_id(13),'agent','active',0,0,0,0,false,0,0,0),
 (pg_temp.cr_id(204),pg_temp.cr_id(101),pg_temp.cr_id(14),'agent','active',0,0,100,0,false,0,0,0),
 (pg_temp.cr_id(205),pg_temp.cr_id(101),pg_temp.cr_id(15),'agent','active',0,0,100,90,false,0,0,0),
 (pg_temp.cr_id(206),pg_temp.cr_id(101),pg_temp.cr_id(16),'agent','active',0,0,100,0,false,0,0,0),
 (pg_temp.cr_id(207),pg_temp.cr_id(101),pg_temp.cr_id(17),'super_agent','active',0,0,200,0,false,0,0,0),
 (pg_temp.cr_id(208),pg_temp.cr_id(101),pg_temp.cr_id(18),'super_agent','active',0,0,100,0,false,0,0,0),
 (pg_temp.cr_id(209),pg_temp.cr_id(101),pg_temp.cr_id(19),'agent','active',0,0,90,0,false,0,0,0),
 (pg_temp.cr_id(301),pg_temp.cr_id(102),pg_temp.cr_id(2),'agent','active',0,0,500,0,false,0,0,0);
UPDATE public.agents SET parent_agent_id=pg_temp.cr_id(207) WHERE id=pg_temp.cr_id(208);
UPDATE public.agents SET parent_agent_id=pg_temp.cr_id(208) WHERE id=pg_temp.cr_id(209);
INSERT INTO public.agents(id,club_id,user_id,role,status,commission_rate,player_rakeback_rate,
 credit_limit,credit_used,is_prepaid,agent_wallet_balance,player_wallet_balance,promo_wallet_balance)
 SELECT pg_temp.cr_id(200+n),pg_temp.cr_id(101),pg_temp.cr_id(n),'agent','active',0,0,100,0,false,0,0,0
 FROM generate_series(20,40)n;
SET LOCAL session_replication_role=origin;
SELECT pg_temp.cr_check((SELECT count(*)=31 AND bool_and((credit_control_revision=0) IS TRUE)
 FROM public.agents WHERE club_id IN(pg_temp.cr_id(101),pg_temp.cr_id(102))),
 'synthetic starting accounts have exact zero activation revisions');
