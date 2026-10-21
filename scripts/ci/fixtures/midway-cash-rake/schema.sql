CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
CREATE TABLE clubs(id uuid PRIMARY KEY, name text, union_id uuid, asset text DEFAULT 'chips', default_rake_percent numeric DEFAULT -1, rake_cap numeric DEFAULT -1, rake_percent numeric, bbj_rake_enabled boolean);
CREATE TABLE tables(id uuid PRIMARY KEY, club_id uuid, union_id uuid, tournament_id uuid, small_blind numeric, big_blind numeric, game_variant text, max_players integer, rake_percent numeric DEFAULT -1, rake_cap_bb numeric DEFAULT -1);
ALTER TABLE tables ADD CONSTRAINT tables_rake_percent_range CHECK(rake_percent BETWEEN -1 AND 10), ADD CONSTRAINT tables_rake_cap_bb_range CHECK(rake_cap_bb BETWEEN -1 AND 10);
ALTER TABLE clubs ADD CONSTRAINT clubs_default_rake_percent_range CHECK(default_rake_percent BETWEEN -1 AND 10), ADD CONSTRAINT clubs_rake_cap_range CHECK(rake_cap BETWEEN -1 AND 10);
CREATE TABLE club_opening_setups(id uuid);
CREATE TABLE hand_history(id uuid,table_id uuid,hand_number integer,tournament_id uuid,created_at timestamptz,rake_amount numeric,bbj_amount numeric,pot_size numeric,game_variant text,players jsonb,community_cards text[],community_cards2 text[],showdown jsonb,actions jsonb);
CREATE TABLE rake_records(hand_id uuid,bbj_contribution numeric,num_players integer);
CREATE TABLE poker_diamond_hand_receipts(table_id uuid,hand_number integer,receipt jsonb);
CREATE TABLE ca_rake_schedule(sb numeric,bb numeric,rake_percent numeric,rake_cap numeric,bbj_fee_bb numeric,source text);
CREATE TABLE ca_rake_tier(label text,min_bb numeric,max_bb numeric,rake_percent numeric,rake_cap numeric,bbj_fee_bb numeric);
CREATE TABLE ca_rake_schedule_caps(bb numeric,players_dealt integer,rake_cap numeric,source text);
CREATE TABLE ca_rake_rules(id integer,short_handed_max_players integer,short_handed_min_seats integer,short_handed_cap_factor numeric,heads_up_cap_factor numeric,heads_up_percent numeric,max_rake_percent numeric,max_rake_cap_bb numeric,no_flop_no_drop boolean);
INSERT INTO ca_rake_rules VALUES(1,3,9,.75,.5,5,10,10,true);
INSERT INTO ca_rake_schedule VALUES(.1,.2,10,3,.6,'engine_mirror'),(1,2,10,5,.25,'engine_mirror'),(5,10,10,12.5,.06,'engine_mirror');
INSERT INTO ca_rake_tier VALUES('nano',.1,.2,10,3,.6),('small',1,3,10,5,.25),('high',9,40,10,15,.06),('nosebleeds',41,NULL,10,20,.03);
INSERT INTO ca_rake_schedule_caps SELECT bb,d,round(rake_cap*CASE WHEN d=2 THEN .5 WHEN d=3 THEN .75 ELSE 1 END,2),'schedule' FROM ca_rake_schedule CROSS JOIN(VALUES(2),(3),(4)) x(d);
-- These two unrelated integrations are not executed by the rake qualifier.
-- The production BBJ body is unchanged by this migration and by its engine code.
CREATE FUNCTION fn_effective_bbj_drop(numeric,integer,boolean,uuid,uuid,text,numeric,numeric,numeric) RETURNS numeric LANGUAGE sql AS $$ SELECT 0::numeric $$;
CREATE FUNCTION fn_ca_guard_watchlist() RETURNS text[] LANGUAGE sql AS $$ SELECT '{}'::text[] $$;
CREATE FUNCTION fn_ca_declare_guard_redefinition(text,text) RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;
