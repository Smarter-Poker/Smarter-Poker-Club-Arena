-- Disposable tables needed by the actual captured read functions.
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
CREATE FUNCTION fn_is_union_overseer(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
ALTER TABLE profiles ADD COLUMN is_admin boolean, ADD COLUMN arena_avatar_url text,
 ADD COLUMN avatar_url text, ADD COLUMN last_login timestamptz;
ALTER TABLE club_members ADD COLUMN promo_balance numeric, ADD COLUMN nickname text,
 ADD COLUMN notes text, ADD COLUMN display_name text, ADD COLUMN last_active_at timestamptz;
ALTER TABLE agents ADD COLUMN promo_wallet_balance numeric;
ALTER TABLE clubs ADD COLUMN name text;
ALTER TABLE chip_transactions ADD COLUMN created_at timestamptz;
ALTER TABLE club_roster_hand_totals ADD COLUMN hands bigint DEFAULT 0;
CREATE TABLE club_member_daily_facts_state(singleton boolean,initialized boolean);
INSERT INTO club_member_daily_facts_state VALUES(true,true);
CREATE TABLE club_member_daily_facts(user_id uuid,club_id uuid,played_on date,is_mtt boolean,hands bigint,fees numeric,net numeric);
CREATE TABLE club_member_play_totals(user_id uuid,club_id uuid,hands bigint,mtt_hands bigint,fees numeric,mtt_fees numeric,net numeric,mtt_net numeric);
UPDATE profiles SET status='active' WHERE id='00000000-0000-0000-0000-000000000003';
