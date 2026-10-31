CREATE TABLE club_members(user_id uuid,club_id uuid,role text,agent_id uuid,status text,joined_at timestamptz,chip_balance numeric);
CREATE TABLE profiles(id uuid,player_number text,alias text,username text,display_name text,first_name text,last_name text,full_name text,is_online boolean,last_seen timestamptz,status text);
CREATE TABLE tables(id uuid,status text,club_id uuid);
CREATE TABLE table_seats(user_id uuid,table_id uuid,left_at timestamptz,club_id uuid);
CREATE FUNCTION fn_club_scope_ids(uuid) RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY[$1] $$;
CREATE FUNCTION ca_club_roster_access(uuid,uuid) RETURNS text LANGUAGE sql AS $$ SELECT coalesce(nullif(current_setting('test.access',true),''),'staff') $$;
CREATE FUNCTION fn_club_role_rank(text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
CREATE FUNCTION fn_arena_name(text,text,text,text,text,text) RETURNS text LANGUAGE sql AS $$ SELECT coalesce($1,$2,$3,$4,$5,$6) $$;
INSERT INTO club_members VALUES
 ('a867f37c-795c-4458-9b82-323e84b65eed','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','player','e5abee6e-abe2-4400-9005-b5c81577155d','active',now(),10);
INSERT INTO profiles(id,player_number,username,status) VALUES('a867f37c-795c-4458-9b82-323e84b65eed','1006080','WhatTheBell','active');
INSERT INTO ca_club_rake_daily_user VALUES
 ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4','a867f37c-795c-4458-9b82-323e84b65eed','2026-10-26',722),
 ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4','a867f37c-795c-4458-9b82-323e84b65eed','2026-10-23',4992);
