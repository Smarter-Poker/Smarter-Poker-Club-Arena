CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA smarter_private;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '69f2cefa-017d-49f3-ac3e-61505633747c'::uuid $$;
CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION public.ca_assert_player_stats_club(uuid,uuid,text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
CREATE FUNCTION public.fn_ca_fee_counting_start() RETURNS date LANGUAGE sql AS $$ SELECT '2026-10-12'::date $$;
CREATE TABLE public.ca_club_rake_daily_user(club_id uuid,user_id uuid,day date,rake_cents bigint);
CREATE TABLE public.ca_club_member_tournament_fee_daily(club_id uuid,user_id uuid,day date,fees numeric);
CREATE TABLE public.clubs(id uuid,asset text);
CREATE TABLE public.ca_hand_facts(user_id uuid,club_id uuid,table_id uuid,hand_id uuid,tournament_id uuid,played_at timestamptz,rake_paid numeric,big_blind numeric);
CREATE TABLE public.cash_participant_funding_receipts(id uuid,table_id uuid,account_entity_id uuid,seat_joined_at timestamptz,funding_club_id uuid,operation_kind text,recorded_at timestamptz);
CREATE TABLE public.tournament_players(tournament_id uuid,user_id uuid,club_id uuid);
CREATE TABLE public.rake_attributions(hand_id uuid,player_id uuid,club_id uuid);
INSERT INTO clubs VALUES ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4','chips');
INSERT INTO ca_club_rake_daily_user VALUES
 ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4','69f2cefa-017d-49f3-ac3e-61505633747c','2026-10-22',64466),
 ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4','69f2cefa-017d-49f3-ac3e-61505633747c','2026-10-23',5073),
 ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4','11111111-1111-1111-1111-111111111111','2026-10-23',900);
INSERT INTO ca_club_member_tournament_fee_daily VALUES
 ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4','69f2cefa-017d-49f3-ac3e-61505633747c','2026-10-23',3.50);
INSERT INTO ca_hand_facts VALUES
 ('69f2cefa-017d-49f3-ac3e-61505633747c','a41434bb-8d0c-400a-8f0d-e8b3d65afed4',null,null,null,'2026-10-22',644.66,2),
 ('69f2cefa-017d-49f3-ac3e-61505633747c','a41434bb-8d0c-400a-8f0d-e8b3d65afed4',null,null,null,'2026-10-23',50.73,2);
