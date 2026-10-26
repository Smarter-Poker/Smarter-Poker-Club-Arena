-- Isolated PostgreSQL additions only. Existing cash schema and original authorities are loaded first.
CREATE TABLE public.union_clubs(union_id uuid,club_id uuid);
INSERT INTO public.union_clubs VALUES
 ('fade0000-0000-0000-0000-000000000001','946747c6-b991-4220-b0cb-effbea46ecd2'),
 ('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000002');
INSERT INTO public.unions VALUES ('fade0000-0000-0000-0000-000000000001'),('90000000-0000-4000-8000-000000000001');
INSERT INTO public.clubs(id,owner_id,is_public,asset) VALUES
 ('fade0000-0000-0000-0000-000000000001',NULL,true,'chips'),
 ('946747c6-b991-4220-b0cb-effbea46ecd2',NULL,true,'chips'),
 ('a0000000-0000-0000-0000-000000000001',NULL,true,'chips'),
 ('90000000-0000-4000-8000-000000000002',NULL,true,'chips'),
 ('90000000-0000-4000-8000-000000000003',NULL,true,'chips');
ALTER TABLE public.clubs ADD COLUMN union_id uuid, ADD COLUMN is_union boolean DEFAULT false;
UPDATE public.clubs SET union_id='fade0000-0000-0000-0000-000000000001'
 WHERE id='a0000000-0000-0000-0000-000000000001';
CREATE FUNCTION public.fn_ca_commerce_admit(text,uuid,text,text,jsonb) RETURNS jsonb
 LANGUAGE sql AS $$ SELECT '{"allowed":true}'::jsonb $$;
SELECT set_config('fixture.uid','90000000-0000-4000-8000-000000000099',false);
-- Source chairs use the real table-seat authority key. Existing live union custody must remain untouched.
INSERT INTO public.tables(id,club_id,union_id,cluster_id,name,role,main_index,lifecycle,is_deleted,status)
 SELECT md5(g.id::text||':fixture-table')::uuid,g.club_id,g.union_id,g.id,g.name,'main',1,'live',false,'waiting'
 FROM public.cash_games g WHERE g.club_id IN ('946747c6-b991-4220-b0cb-effbea46ecd2','fade0000-0000-0000-0000-000000000001');
INSERT INTO public.table_seats(id,table_id,user_id,seat_number,stack)
 VALUES('90000000-0000-4000-8000-000000000020',md5('95beda17-1629-4866-b888-cc1c920d4a91:fixture-table')::uuid,
 '90000000-0000-4000-8000-000000000099',1,33.33);
CREATE TABLE fixture_midway_catalog_before AS SELECT * FROM cash_games;
REVOKE ALL ON FUNCTION public.fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean) FROM PUBLIC,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_game_ensure(uuid,text,numeric,numeric,text,integer) FROM PUBLIC,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_ensure(uuid,text,numeric,numeric,text,integer) TO service_role;
