DO $$ BEGIN CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA auth; CREATE SCHEMA realtime;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.viewer',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'authenticated'::text $$;
CREATE TABLE realtime.messages(extension text,private boolean,topic text); ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql AS $$ SELECT ''::text $$;
CREATE TABLE public.signals(topic text,payload jsonb);
CREATE FUNCTION realtime.send(payload jsonb,event text,topic text,private boolean) RETURNS void LANGUAGE sql AS $$ INSERT INTO public.signals VALUES(topic,payload) $$;
CREATE TABLE club_members(user_id uuid,club_id uuid,role text,agent_id uuid,chip_balance numeric,promo_balance numeric,nickname text,notes text,display_name text,joined_at timestamptz,status text);
CREATE TABLE clubs(id uuid,name text);
CREATE TABLE profiles(id uuid,player_number text,alias text,username text,display_name text,first_name text,last_name text,full_name text,arena_avatar_url text,avatar_url text,last_login timestamptz,last_seen timestamptz,is_online boolean,status text);
CREATE TABLE tables(id uuid,status text,club_id uuid);
CREATE TABLE table_seats(user_id uuid,table_id uuid,club_id uuid,left_at timestamptz,joined_at timestamptz);
CREATE TABLE agents(user_id uuid,club_id uuid,status text,agent_wallet_balance numeric,promo_wallet_balance numeric);
CREATE TABLE chip_transactions(to_user_id uuid,from_user_id uuid,club_id uuid,amount numeric,transaction_type text,created_at timestamptz);
CREATE TABLE ca_declared_money_triggers(table_name text,trigger_name text,note text);
CREATE TABLE club_member_daily_facts(club_id uuid,user_id uuid,played_on date,game_variant text,is_mtt boolean,hands bigint,wins bigint,vpip_hands bigint,pfr_hands bigint,tb_hands bigint,faced_tb bigint,folded_tb bigint,cb_hands bigint,cb_opps bigint,fees numeric,net numeric);
CREATE TABLE club_member_play_totals(club_id uuid,user_id uuid,hands bigint,mtt_hands bigint,fees numeric,mtt_fees numeric,net numeric,mtt_net numeric);
CREATE TABLE club_member_daily_facts_state(singleton boolean,initialized boolean); INSERT INTO club_member_daily_facts_state VALUES(true,true);
CREATE TABLE ca_hand_facts(hand_id uuid,user_id uuid,club_id uuid,table_id uuid,tournament_id uuid,played_at timestamptz,game_variant text,net numeric,rake_paid numeric,vpip boolean,pfr boolean,three_bet boolean,faced_three_bet boolean,folded_to_three_bet boolean,cbet_flop boolean,had_cbet_flop_opp boolean);
CREATE INDEX ON ca_hand_facts(user_id,played_at);
CREATE TABLE rake_attributions(hand_id uuid,player_id uuid,club_id uuid,PRIMARY KEY(hand_id,player_id));
CREATE TABLE cash_participant_funding_receipts(id uuid,operation_kind text,table_id uuid,account_entity_id uuid,funding_club_id uuid,seat_joined_at timestamptz,recorded_at timestamptz);
CREATE TABLE tournament_players(tournament_id uuid,user_id uuid,club_id uuid);
CREATE FUNCTION fn_ca_launch_accounting_accepts(uuid,timestamptz) RETURNS boolean LANGUAGE sql AS $$ SELECT nullif(current_setting('test.cutoff',true),'') IS NULL OR $2>=nullif(current_setting('test.cutoff',true),'')::timestamptz $$;
CREATE FUNCTION fn_club_scope_ids(uuid) RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY[$1] $$;
CREATE FUNCTION ca_club_roster_access(uuid,uuid) RETURNS text LANGUAGE sql AS $$ SELECT coalesce(nullif(current_setting('test.access',true),''),'staff') $$;
CREATE FUNCTION fn_club_role_rank(text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
CREATE FUNCTION fn_arena_name(text,text,text,text,text,text) RETURNS text LANGUAGE sql AS $$ SELECT $1 $$;
CREATE FUNCTION ca_club_member_fee_totals(uuid,date,date,uuid) RETURNS TABLE(user_id uuid,cash_fees numeric,tournament_fees numeric) LANGUAGE sql AS $$ SELECT $4,16.55::numeric,0::numeric $$;
CREATE FUNCTION ca_club_member_tournament_money(uuid,uuid,timestamptz,timestamptz) RETURNS numeric LANGUAGE sql AS $$ SELECT 0::numeric $$;

CREATE TABLE ca_club_rake_daily_user(user_id uuid,club_id uuid);
CREATE TABLE ca_club_member_tournament_fee_daily(user_id uuid,club_id uuid);

CREATE FUNCTION fn_ca_launch_accounting_cutoff(text,uuid) RETURNS timestamptz LANGUAGE sql AS $$ SELECT nullif(current_setting('test.cutoff',true),'')::timestamptz $$;

-- A separate member changes funding clubs on the same physical table, then
-- returns. Initialization must agree with the scalar live-trigger resolver.
INSERT INTO clubs VALUES('00000000-0000-0000-0000-000000000007','Second');
INSERT INTO cash_participant_funding_receipts
SELECT ('00000000-0000-0000-0001-'||lpad(n::text,12,'0'))::uuid,'buyin',
 '00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000008',
 CASE WHEN n=2 THEN '00000000-0000-0000-0000-000000000007'::uuid ELSE '00000000-0000-0000-0000-000000000001'::uuid END,
 now()-interval '4 hours'+n*interval '1 hour',now() FROM generate_series(1,3) n;
INSERT INTO ca_hand_facts(hand_id,user_id,club_id,table_id,played_at,game_variant,net,rake_paid)
SELECT ('00000000-0000-0000-0002-'||lpad(n::text,12,'0'))::uuid,
 '00000000-0000-0000-0000-000000000008','00000000-0000-0000-0000-000000000007',
 '00000000-0000-0000-0000-000000000004',now()-interval '4 hours'+n*interval '1 hour','nlh',n,0
FROM generate_series(0,3) n;
