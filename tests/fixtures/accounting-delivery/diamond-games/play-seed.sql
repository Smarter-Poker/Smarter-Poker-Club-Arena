-- Synthetic local player, loaded before canonical money triggers, never copied to production.
INSERT INTO auth.users(id) VALUES('d1000000-0000-4000-8000-000000000005');
INSERT INTO profiles(id,username,diamonds,diamond_balance) VALUES('d1000000-0000-4000-8000-000000000005','diamond_play_probe',100000,100000);
INSERT INTO club_members(club_id,user_id,role,status,chip_balance) VALUES('d1000000-0000-4000-8000-000000000003','d1000000-0000-4000-8000-000000000005','player','active',0);
-- Current approved Steady table, read back September 17.
INSERT INTO plinko_tables(version,name,multipliers_cents,max_multiplier_cents,activated_at) VALUES(1,'Steady',ARRAY[2000,1000,500,250,160,130,100,65,0,65,100,130,160,250,500,1000,2000],2000,now());
INSERT INTO diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds) VALUES('d1000000-0000-4000-8000-000000000003','club','plinko',true,0);
INSERT INTO diamond_game_pools(host_id,game) VALUES('d1000000-0000-4000-8000-000000000003','plinko');
INSERT INTO diamond_spins_owner_consents(host_id,owner_id,host_kind,terms_version,terms_text) VALUES('d1000000-0000-4000-8000-000000000003','d1000000-0000-4000-8000-000000000002','club','diamond-spins-2026-09-14-v1','Synthetic owner consent in isolated test only');
