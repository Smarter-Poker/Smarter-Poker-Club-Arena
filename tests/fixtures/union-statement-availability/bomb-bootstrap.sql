-- The captured before/after calendar counterexample uses UTC dates.
-- Later real-producer qualification explicitly exercises other timezones.
SET TIME ZONE 'UTC';
SELECT set_config('app.user_id','00000000-0000-4000-8000-000000000002',false);
ALTER TABLE clubs ADD COLUMN owner_id uuid;
CREATE TABLE club_members(club_id uuid,user_id uuid,role text);
CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,name text);
CREATE TABLE hand_history(id uuid,table_id uuid,bomb_pot jsonb,created_at timestamptz,pot_size numeric,rake_amount numeric,players jsonb);
CREATE TABLE bomb_pot_award_units(hand_history_id uuid,user_id uuid,created_at timestamptz);
CREATE TABLE ca_club_bomb_pot_complete(club_id uuid,day date);
CREATE TABLE ca_club_bomb_pot_daily(club_id uuid,day date,table_id uuid,trigger_reason text,board_count integer,variant text,hands bigint,seats_sum numeric,pot_sum numeric,rake_sum numeric,ante_sum numeric,scoops bigint,splits bigint,unrecorded bigint);
CREATE TABLE rollup_calls(club_id uuid,day date);
-- Native-only record of catchup admission. Money/award writes are not invoked.
CREATE FUNCTION fn_ca_bomb_pot_rollup_day(uuid,date) RETURNS void LANGUAGE sql AS $$ INSERT INTO rollup_calls VALUES($1,$2) $$;
INSERT INTO club_members SELECT id,'00000000-0000-4000-8000-000000000002','owner' FROM clubs;
INSERT INTO tables SELECT id,id,name FROM clubs;
INSERT INTO hand_history SELECT id,id,'{"trigger_reason":"interval","board_count":2,"variant":"plo4","ante_amount":1}',((current_date-2)::timestamp AT TIME ZONE 'UTC'),20,1,'[{},{}]' FROM tables WHERE id='00000000-0000-4000-8000-000000000003';
-- Old catchup uses the global oldest hand, even for another club. This
-- older foreign fact makes current_date-3 an empty day for the requested club
-- that is always outside the 15-minute midnight grace. Yesterday is not.
INSERT INTO hand_history SELECT id,id,'{"trigger_reason":"interval","board_count":2,"variant":"plo4","ante_amount":1}',((current_date-3)::timestamp AT TIME ZONE 'UTC'),20,1,'[{},{}]' FROM tables WHERE id='00000000-0000-4000-8000-000000000005';
-- An old sealed fact at the seven-day boundary must be excluded.
INSERT INTO ca_club_bomb_pot_complete SELECT id,current_date-7 FROM clubs;
INSERT INTO ca_club_bomb_pot_daily SELECT id,current_date-7,id,'interval',2,'plo4',1,2,100,1,2,1,0,0 FROM clubs;

CREATE TABLE bomb_archive_before AS SELECT md5(string_agg(to_jsonb(d)::text,',' ORDER BY club_id,day,table_id)) hash FROM ca_club_bomb_pot_daily d;
