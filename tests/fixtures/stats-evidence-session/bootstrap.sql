CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
CREATE TABLE public.clubs(id uuid PRIMARY KEY,asset text,lifecycle_status text);
CREATE TABLE public.club_members(club_id uuid,user_id uuid,status text);
CREATE TABLE public.tables(id uuid PRIMARY KEY,club_id uuid,cluster_id uuid);
CREATE TABLE public.cash_player_session(id uuid PRIMARY KEY,player_id uuid,club_id uuid,table_id uuid,cluster_id uuid,opened_at timestamptz,closed_at timestamptz);
CREATE TABLE public.ca_hand_facts(
 hand_id uuid,user_id uuid,club_id uuid,table_id uuid,tournament_id uuid,played_at timestamptz,
 net numeric,net_bb numeric,game_variant text,three_bet boolean,four_bet boolean,stole boolean,
 squeezed boolean,defended_blind boolean,cbet_flop boolean,barreled_turn boolean,barreled_river boolean,
 check_raised boolean,donk_bet boolean,probe_bet boolean,three_bet_opportunity boolean,
 four_bet_opportunity boolean,steal_opportunity boolean,squeeze_opportunity boolean,
 blind_defense_opportunity boolean,cbet_flop_opportunity boolean,barrel_turn_opportunity boolean,
 barrel_river_opportunity boolean,check_raise_opportunity boolean,donk_opportunity boolean,probe_opportunity boolean);
CREATE FUNCTION public.ca_assert_self(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF auth.uid() IS DISTINCT FROM p_user THEN RAISE EXCEPTION 'refused' USING ERRCODE='42501'; END IF; END$$;
CREATE FUNCTION public.ca_player_stats_hand_evidence(uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text,boolean,boolean,boolean,boolean,text,boolean,text,timestamptz,uuid,integer)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$SELECT '{}'::jsonb$$;
