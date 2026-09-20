-- Explicit synthetic starting state, loaded BEFORE the canonical money triggers.
-- No production users, wallet rows, credentials or signup trigger are copied.
INSERT INTO auth.users(id) VALUES
 ('d1000000-0000-4000-8000-000000000001'),
 ('d1000000-0000-4000-8000-000000000002'),
 ('2d1cd6c3-5700-4af9-a271-d4863fdab20d');
INSERT INTO public.profiles(id,username,diamonds,diamond_balance) VALUES
 ('d1000000-0000-4000-8000-000000000001','diamond_probe_player',0,0),
 ('d1000000-0000-4000-8000-000000000002','diamond_probe_owner',100000,100000),
 ('2d1cd6c3-5700-4af9-a271-d4863fdab20d','diamond_probe_other_operator',0,0);
INSERT INTO public.unions(id,name,owner_id,slug) VALUES
 ('d1000000-0000-4000-8000-000000000004','Diamond Probe Union','d1000000-0000-4000-8000-000000000002','diamond-probe-union');
INSERT INTO public.clubs(id,name,owner_id,union_id,chip_treasury,promo_balance,is_union) VALUES
 ('d1000000-0000-4000-8000-000000000004','Diamond Probe Union Board','d1000000-0000-4000-8000-000000000002',NULL,100000,100000,true),
 ('2a1132b9-5ba2-42e6-9f01-30a7fcffebe3','Diamond Probe Union Club','d1000000-0000-4000-8000-000000000002','d1000000-0000-4000-8000-000000000004',100000,100000,false),
 ('a0000000-0000-0000-0000-000000000001','Diamond Probe Standalone Club','d1000000-0000-4000-8000-000000000002',NULL,100000,100000,false),
 ('d1000000-0000-4000-8000-000000000003','Diamond Probe Daily Club','d1000000-0000-4000-8000-000000000002',NULL,100000,100000,false);
INSERT INTO public.union_wallets(union_id,chip_balance,promo_wallet) VALUES
 ('d1000000-0000-4000-8000-000000000004',100000,100000);
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES
 ('d1000000-0000-4000-8000-000000000004','2d1cd6c3-5700-4af9-a271-d4863fdab20d','co_owner','active',0),
 ('a0000000-0000-0000-0000-000000000001','2d1cd6c3-5700-4af9-a271-d4863fdab20d','co_owner','active',0),
 ('d1000000-0000-4000-8000-000000000003','d1000000-0000-4000-8000-000000000001','player','active',0);
INSERT INTO public.ca_bridge_rate(id,diamonds_per_chip,note) VALUES(1,100,'Original probe exchange rate');
INSERT INTO public.ca_financial_epochs(name,is_current) VALUES('Isolated Diamond financial probe',true);
INSERT INTO public.ca_chip_store_coverage(store,treatment,counted_by,notes) VALUES
 ('club_treasury','counted','clubs.chip_treasury','Synthetic starting store'),
 ('union_bank','counted','union_wallets.chip_balance','Synthetic starting store'),
 ('union_wallet','counted','union_wallets named subwallets','Original union autoledger store name'),
 ('promo_wallet','counted','clubs.promo_balance / union_wallets.promo_wallet','Synthetic starting store'),
 ('player_wallet','counted','club_members.chip_balance','Synthetic starting store');
INSERT INTO public.wheel_configs(host_id,host_kind,enabled,segment_version,purchased_only,
 welcome_spin_enabled,welcome_budget_chips,min_seconds_between_spins) VALUES
 ('d1000000-0000-4000-8000-000000000003','club',true,1,false,true,100,0);
INSERT INTO public.wheel_pools(host_id,diamond_float,diamond_seed) VALUES
 ('d1000000-0000-4000-8000-000000000003',2500,2500);
-- Fail closed if the synthetic player accidentally enters a fixture/Horse bypass.
DO $$ BEGIN
 IF public.fn_ca_is_fixture_account('d1000000-0000-4000-8000-000000000001')
    OR public.fn_ca_is_cert_account('d1000000-0000-4000-8000-000000000001')
    OR EXISTS(SELECT 1 FROM public.profiles WHERE is_horse) THEN
   RAISE EXCEPTION 'Synthetic identities must exercise ordinary player eligibility';
 END IF;
END $$;
