-- Isolated extension of the lifecycle fixture; no production rows.
ALTER TABLE club_members ADD COLUMN agent_id uuid, ADD COLUMN joined_at timestamptz DEFAULT now();
ALTER TABLE profiles ADD COLUMN player_number text, ADD COLUMN alias text,
 ADD COLUMN display_name text, ADD COLUMN first_name text, ADD COLUMN last_name text,
 ADD COLUMN full_name text, ADD COLUMN is_online boolean, ADD COLUMN last_seen timestamptz;
CREATE TABLE tables(id uuid,status text,club_id uuid);
CREATE TABLE table_seats(user_id uuid,table_id uuid,left_at timestamptz,club_id uuid);
CREATE TABLE club_roster_hand_totals(club_id uuid,user_id uuid,fees numeric);
CREATE FUNCTION fn_club_scope_ids(uuid) RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY[$1] $$;
CREATE FUNCTION ca_club_roster_access(uuid,uuid) RETURNS text LANGUAGE sql AS $$ SELECT coalesce(current_setting('fixture.access',true),'service') $$;
CREATE FUNCTION fn_club_role_rank(text) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
CREATE FUNCTION fn_arena_name(text,text,text,text,text,text) RETURNS text LANGUAGE sql AS $$ SELECT coalesce($1,$2,$3,$6,'Unknown') $$;
UPDATE club_members SET agent_id='00000000-0000-0000-0000-000000000003' WHERE user_id='00000000-0000-0000-0000-000000000002';
UPDATE club_members SET agent_id='00000000-0000-0000-0000-000000000002' WHERE user_id='00000000-0000-0000-0000-000000000001';
INSERT INTO club_members(club_id,user_id,role,status,chip_balance,agent_id) VALUES
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000004','player','approved',0,'00000000-0000-0000-0000-000000000003');
INSERT INTO club_roster_hand_totals VALUES
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',12.34);
