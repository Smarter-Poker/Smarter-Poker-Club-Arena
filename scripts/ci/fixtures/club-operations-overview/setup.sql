CREATE ROLE authenticated;
CREATE ROLE anon;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
CREATE TABLE clubs(id uuid PRIMARY KEY,name text,slug text,chip_treasury numeric,settlement_locked boolean);
CREATE TABLE club_members(club_id uuid,user_id uuid,role text,status text,created_at timestamptz,chip_balance numeric);
CREATE TABLE profiles(id uuid PRIMARY KEY,is_online boolean,last_seen timestamptz,platform_admin boolean DEFAULT false);
CREATE FUNCTION fn_is_platform_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT coalesce((SELECT platform_admin FROM profiles WHERE id=auth.uid()),false)$$;
CREATE FUNCTION fn_club_bank_role(uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT role FROM club_members WHERE club_id=$1 AND user_id=auth.uid() LIMIT 1$$;
CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,status text);
CREATE TABLE table_seats(table_id uuid,user_id uuid,left_at timestamptz);
CREATE TABLE tournaments(club_id uuid,status text);
CREATE TABLE club_hand_daily(club_id uuid,stat_date date,hands bigint,rake numeric,PRIMARY KEY(club_id,stat_date));
CREATE TABLE ca_club_rake_daily(club_id uuid,stat_date date,hands bigint,rake numeric,PRIMARY KEY(club_id,stat_date));
CREATE TABLE user_reports(reported_user_id uuid,status text);
CREATE TABLE disputes(club_id uuid,created_at timestamptz,status text);
CREATE TABLE blacklists(club_id uuid,expires_at timestamptz);
CREATE TABLE chip_requests(club_id uuid,status text);
CREATE TABLE cashout_requests(club_id uuid,completed_at timestamptz,cancelled_at timestamptz,status text);
CREATE TABLE credit_requests(club_id uuid,status text);
CREATE TABLE settlement_invoices(club_id uuid,due_at timestamptz,status text);
CREATE TABLE tournament_tickets(club_id uuid,redeemed_at timestamptz,cancelled_at timestamptz,status text);
CREATE TABLE anti_cheat_flags(club_id uuid,player_id uuid,status text);
GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated,anon,service_role;
INSERT INTO clubs VALUES ('00000000-0000-0000-0000-000000000001','Fixture Club','fixture',123456.789,false),('00000000-0000-0000-0000-000000000002','Other Club','other',9,false);
INSERT INTO club_members SELECT '00000000-0000-0000-0000-000000000001', lpad(i::text,32,'0')::uuid, CASE WHEN i=1 THEN 'owner' ELSE 'member' END,
 CASE i WHEN 2 THEN 'pending' WHEN 3 THEN 'banned' WHEN 4 THEN 'suspended' WHEN 6 THEN 'automatic' WHEN 7 THEN 'approved' ELSE 'active' END,
 CASE WHEN i IN (5,8) THEN now()-interval '8 days' ELSE now() END, i*10.123 FROM generate_series(1,8) i;
INSERT INTO profiles SELECT user_id,true,CASE WHEN user_id='00000000-0000-0000-0000-000000000005' THEN now()-interval '6 minutes' ELSE now() END,false FROM club_members;
INSERT INTO tables VALUES ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','running'),('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000001','waiting'),('00000000-0000-0000-0000-000000000013','00000000-0000-0000-0000-000000000001','closed');
INSERT INTO table_seats VALUES ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001',NULL),('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000001',NULL),('00000000-0000-0000-0000-000000000013','00000000-0000-0000-0000-000000000009',NULL),('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000008',NULL),('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000010',now());
INSERT INTO ca_club_rake_daily VALUES ('00000000-0000-0000-0000-000000000001',(now() AT TIME ZONE 'UTC')::date,42,130482.8648);
INSERT INTO anti_cheat_flags VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','open'),(NULL,'00000000-0000-0000-0000-000000000001','open'),(NULL,'00000000-0000-0000-0000-000000000006','open'),(NULL,'00000000-0000-0000-0000-000000000099','open'),('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','open'),(NULL,'00000000-0000-0000-0000-000000000001','resolved');
ALTER TABLE tables ADD COLUMN name text, ADD COLUMN created_at timestamptz, ADD COLUMN created_by uuid, ADD COLUMN is_deleted boolean;
ALTER TABLE profiles ADD COLUMN alias text,ADD COLUMN username text,ADD COLUMN display_name text,ADD COLUMN first_name text,ADD COLUMN last_name text,ADD COLUMN full_name text,ADD COLUMN avatar_url text;
CREATE TABLE club_announcements(id uuid,club_id uuid,title text,content text,message text,created_at timestamptz,author_id uuid,created_by uuid,is_active boolean);
CREATE TABLE hand_history(id uuid,table_id uuid,pot_size numeric,big_blind numeric,created_at timestamptz,winners jsonb,hand_name text);
CREATE INDEX hand_history_table_created ON hand_history(table_id,created_at DESC);
CREATE FUNCTION ca_can_view_club(uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT session_user='postgres' OR coalesce(auth.role()='service_role',false) OR EXISTS(SELECT 1 FROM club_members WHERE club_id=$1 AND user_id=auth.uid()) OR fn_is_platform_admin()$$;
CREATE FUNCTION fn_arena_name(text,text,text,text,text,text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT coalesce($1,$2,$3,$4,$5,$6)$$;
INSERT INTO hand_history SELECT lpad((100+i)::text,32,'0')::uuid,'00000000-0000-0000-0000-000000000011',80,2,now()-i*interval '1 minute','[{"userId":"00000000-0000-0000-0000-000000000001"}]','Straight' FROM generate_series(1,40)i;
INSERT INTO hand_history VALUES ('00000000-0000-0000-0000-000000000201',NULL,999999,2,now(),'[]',NULL),('00000000-0000-0000-0000-000000000202','00000000-0000-0000-0000-000000000099',999999,2,now(),'[]',NULL),('00000000-0000-0000-0000-000000000203','00000000-0000-0000-0000-000000000011',79.99,2,now(),'[]',NULL),('00000000-0000-0000-0000-000000000204','00000000-0000-0000-0000-000000000011',99999,2,now()-interval '49 hours','[]',NULL);
INSERT INTO club_announcements VALUES ('00000000-0000-0000-0000-000000000211','00000000-0000-0000-0000-000000000001','Welcome',NULL,NULL,now()-interval '1 second','00000000-0000-0000-0000-000000000001',NULL,true),('00000000-0000-0000-0000-000000000212','00000000-0000-0000-0000-000000000001','Hidden',NULL,NULL,now(),NULL,NULL,false);
UPDATE profiles SET alias='Fixture Alias',avatar_url='fixture.png' WHERE id='00000000-0000-0000-0000-000000000001';
UPDATE tables SET name='Fixture Table',created_at=now()-interval '2 seconds',created_by='00000000-0000-0000-0000-000000000001',is_deleted=false WHERE id='00000000-0000-0000-0000-000000000011';
-- Personnel attribution follows the maintained roster, including shared tables.
ALTER TABLE profiles ADD COLUMN status text;
UPDATE profiles SET status='deleted' WHERE id='00000000-0000-0000-0000-000000000008';
ALTER TABLE table_seats ADD COLUMN club_id uuid;
UPDATE table_seats SET club_id='00000000-0000-0000-0000-000000000001';
INSERT INTO tables(id,club_id,status) VALUES('00000000-0000-0000-0000-000000000014','00000000-0000-0000-0000-000000000002','running');
INSERT INTO table_seats(table_id,user_id,left_at,club_id) VALUES('00000000-0000-0000-0000-000000000014','00000000-0000-0000-0000-000000000005',NULL,'00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000005',NULL,'00000000-0000-0000-0000-000000000001');
ALTER TABLE clubs ADD COLUMN owner_id uuid;
UPDATE clubs SET owner_id='00000000-0000-0000-0000-000000000001' WHERE id='00000000-0000-0000-0000-000000000001';
ALTER TABLE hand_history ADD COLUMN bomb_pot jsonb,ADD COLUMN rake_amount numeric,ADD COLUMN players jsonb;
CREATE TABLE bomb_pot_award_units(hand_history_id uuid,user_id uuid,created_at timestamptz);
CREATE TABLE ca_club_bomb_pot_complete(club_id uuid,day date,rows_written integer,hands_read bigint,computed_at timestamptz,PRIMARY KEY(club_id,day));
CREATE TABLE ca_club_bomb_pot_daily(club_id uuid,day date,table_id uuid,trigger_reason text,board_count integer,variant text,hands bigint,seats_sum numeric,pot_sum numeric,rake_sum numeric,ante_sum numeric,scoops bigint,splits bigint,unrecorded bigint);
INSERT INTO hand_history(id,table_id,pot_size,big_blind,created_at,bomb_pot,rake_amount,players)
 SELECT lpad((300+i)::text,32,'0')::uuid,'00000000-0000-0000-0000-000000000011',i*100,100,
 ((now() AT TIME ZONE 'UTC')::date-2)::timestamptz+i*interval '1 hour',
 '{"trigger_reason":"timer","board_count":2,"variant":"plo","ante_amount":2}',i,'[1,2,3]' FROM generate_series(1,3)i;
INSERT INTO hand_history(id,table_id,pot_size,big_blind,created_at,bomb_pot,rake_amount,players) VALUES
 ('00000000-0000-0000-0000-000000000304','00000000-0000-0000-0000-000000000011',400,100,(now() AT TIME ZONE 'UTC')::date+interval '1 minute','{"trigger_reason":"timer","board_count":2,"variant":"plo","ante_amount":2}',4,'[1,2]'),
 ('00000000-0000-0000-0000-000000000399','00000000-0000-0000-0000-000000000014',9999,100,((now() AT TIME ZONE 'UTC')::date-3)::timestamptz,'{"trigger_reason":"timer","board_count":2,"variant":"plo","ante_amount":2}',999,'[1]'),
 ('00000000-0000-0000-0000-000000000398',NULL,9999,100,now(),'{"trigger_reason":"timer","board_count":2,"variant":"plo","ante_amount":2}',999,'[1]');
INSERT INTO bomb_pot_award_units VALUES('00000000-0000-0000-0000-000000000301','00000000-0000-0000-0000-000000000001',((now() AT TIME ZONE 'UTC')::date-2)::timestamptz+interval '2 hours'),('00000000-0000-0000-0000-000000000301','00000000-0000-0000-0000-000000000001',((now() AT TIME ZONE 'UTC')::date-2)::timestamptz+interval '2 hours'),('00000000-0000-0000-0000-000000000302','00000000-0000-0000-0000-000000000001',((now() AT TIME ZONE 'UTC')::date-2)::timestamptz+interval '3 hours'),('00000000-0000-0000-0000-000000000302','00000000-0000-0000-0000-000000000007',((now() AT TIME ZONE 'UTC')::date-2)::timestamptz+interval '3 hours');
CREATE TABLE ca_club_tournament_daily(club_id uuid,stat_date date,fee numeric);
