BEGIN;
-- Synthetic baseline only. Financial calls run with origin triggers and authenticated JWTs.
SET LOCAL session_replication_role=replica;
INSERT INTO public.users(id,username) VALUES('{{owner}}','cashout_native_agent'),('{{player}}','cashout_native_player');
INSERT INTO public.profiles(id,username,display_name) VALUES('{{owner}}','cashout_native_agent','Native Agent'),('{{player}}','cashout_native_player','Native Player');
INSERT INTO public.clubs(id,club_id,name,owner_id,chip_treasury,is_union,asset,settlement_locked,settlement_lock_until)
VALUES('{{club}}',987432,'Native Cashout Settlement Fixture','{{owner}}',0,false,'chips',true,'2099-01-01');
INSERT INTO public.club_members(club_id,user_id,role,status,is_active,membership_lifecycle_status,chip_balance,agent_id)
VALUES('{{club}}','{{owner}}','owner','active',true,'active',0,NULL),('{{club}}','{{player}}','player','active',true,'active',100,'{{owner}}');
INSERT INTO public.agents(club_id,user_id,role,status,commission_rate,player_rakeback_rate,credit_limit,credit_used,is_prepaid,agent_wallet_balance)
VALUES('{{club}}','{{owner}}','agent','active',0,0,0,0,true,0);
INSERT INTO public.settlement_locks(club_id,unlock_at,is_active,lock_reason) VALUES('{{club}}','2099-01-01',true,'Native settlement refusal regression');
INSERT INTO public.ca_emergency_stops(path,stopped) VALUES('cashout',false);
COMMIT;
