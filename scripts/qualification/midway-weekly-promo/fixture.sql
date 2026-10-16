-- Existing faithful native foundation contains all authoritative journal guards.
-- Test identities and venues are local only; balances are fixture opening data.
-- Social auto-friending requires unrelated production contacts; omit only this
-- creation-only social effect while creating local identities, then restore it.
ALTER TABLE public.profiles DISABLE TRIGGER trg_auto_connect_dan;
INSERT INTO auth.users(id) SELECT md5('midway-native-'||i)::uuid FROM generate_series(1,9)i;
INSERT INTO public.profiles(id,is_horse,horse_status)
 SELECT md5('midway-native-'||i)::uuid,i<>9,CASE WHEN i=8 THEN 'disabled' ELSE 'available' END FROM generate_series(1,9)i
 ON CONFLICT(id) DO UPDATE SET is_horse=excluded.is_horse,horse_status=excluded.horse_status;
-- The authentic journal writer requires its system actor FK even without a JWT.
-- This is a local reference row, with no production account/session access.
INSERT INTO auth.users(id) VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d');
INSERT INTO public.users(id,username) VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d','native_journal_system_actor') ON CONFLICT(id) DO NOTHING;
ALTER TABLE public.profiles ENABLE TRIGGER trg_auto_connect_dan;
INSERT INTO public.union_creators(user_id,note) VALUES(md5('midway-native-9')::uuid,'Local fixture owner');
INSERT INTO public.unions(id,name,owner_id) VALUES('fade0000-0000-0000-0000-000000000001','Native Midway',md5('midway-native-9')::uuid);
-- Existing empty venue fixture: omit the unrelated new-club opening grant
-- only during INSERT; all balance-update and journal guards stay enabled.
ALTER TABLE public.clubs DISABLE TRIGGER trg_seed_new_club_opening_bank;
ALTER TABLE public.clubs DISABLE TRIGGER trg_record_new_club_opening_bank;
INSERT INTO public.clubs(id,name,club_id,owner_id,union_id,chip_treasury)
 VALUES('a0000000-0000-0000-0000-000000000001'::uuid,'Native Midway Club 1',984031,md5('midway-native-9')::uuid,'fade0000-0000-0000-0000-000000000001',0),
 ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,'Native Midway Club 2',984032,md5('midway-native-9')::uuid,'fade0000-0000-0000-0000-000000000001',0);
INSERT INTO public.clubs(id,name,club_id,owner_id,union_id,chip_treasury,is_union) VALUES('fade0000-0000-0000-0000-000000000001','Native Midway Own Board',984033,md5('midway-native-9')::uuid,'fade0000-0000-0000-0000-000000000001',0,true);
INSERT INTO public.union_clubs(union_id,club_id) SELECT 'fade0000-0000-0000-0000-000000000001',CASE WHEN i=1 THEN 'a0000000-0000-0000-0000-000000000001'::uuid ELSE 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid END FROM generate_series(1,2)i ON CONFLICT DO NOTHING;
ALTER TABLE public.clubs ENABLE TRIGGER trg_seed_new_club_opening_bank;
ALTER TABLE public.clubs ENABLE TRIGGER trg_record_new_club_opening_bank;
INSERT INTO public.union_wallets(union_id,promo_wallet) VALUES('fade0000-0000-0000-0000-000000000001',100.03)
 ON CONFLICT(union_id) DO UPDATE SET promo_wallet=excluded.promo_wallet;
SELECT set_config('app.club_membership_source','join_club',false);
INSERT INTO public.club_members(club_id,user_id,is_active,status,membership_lifecycle_status,chip_balance)
 SELECT 'a0000000-0000-0000-0000-000000000001'::uuid,md5('midway-native-'||i)::uuid,i<>7,CASE WHEN i=6 THEN 'banned' ELSE 'active' END,CASE WHEN i=5 THEN 'departed' ELSE 'active' END,
 CASE WHEN i=3 THEN 10000 WHEN i=4 THEN 10001 ELSE 0 END FROM generate_series(1,9)i ON CONFLICT(club_id,user_id) DO NOTHING;
INSERT INTO public.club_members(club_id,user_id,is_active,status,membership_lifecycle_status,chip_balance)
 VALUES('a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,md5('midway-native-1')::uuid,true,'approved','active',12000),
 ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,md5('midway-native-2')::uuid,true,'approved','active',0);
INSERT INTO public.club_members(club_id,user_id,is_active,status,membership_lifecycle_status,chip_balance) VALUES('fade0000-0000-0000-0000-000000000001',md5('midway-native-2')::uuid,true,'active','active',0);
-- Opening fixture balances use the ordinary declared source, never replica mode.
SELECT public.fn_ca_declare_ledger('promo','union_wallet','fade0000-0000-0000-0000-000000000001',NULL,'native-open',ARRAY['union_wallets']);
UPDATE public.club_members SET chip_balance=9999.99 WHERE club_id='a0000000-0000-0000-0000-000000000001'::uuid AND user_id=md5('midway-native-1')::uuid;
-- Control the calendar admission dependency only; the production trigger and
-- disbursement/ledger functions are never rewritten by these behavioral cases.
CREATE OR REPLACE FUNCTION public.fn_union_accounting_run_at(p_period_end timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT '-infinity'::timestamptz$$;
