-- Isolated native catalog. No wallet, buy-in, real player or production connection.
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
CREATE TABLE cash_games(id uuid PRIMARY KEY,club_id uuid,template_name text,ruleset_snapshot jsonb,lightning_enabled boolean DEFAULT true,cluster_mode text DEFAULT 'lightning',cluster_epoch int DEFAULT 1,handedness int DEFAULT 6,enabled boolean DEFAULT true,must_move boolean DEFAULT true,updated_at timestamptz,closed_at timestamptz,name text,variant text,sb numeric,bb numeric);
CREATE TABLE lightning_instance(id uuid PRIMARY KEY,state text,hand_id uuid,cluster_id uuid,cluster_epoch int,deadline_at timestamptz,created_at timestamptz,started_at timestamptz);
CREATE TABLE lightning_hand(hand_id uuid PRIMARY KEY,participants_locked_at timestamptz,player_count int);
CREATE TABLE lightning_hand_player(hand_id uuid,player_id uuid,seat int,pool_slot_id uuid);
CREATE TABLE lightning_reservation(lightning_instance_id uuid,state text,player_id uuid,seat_number int);
CREATE TABLE lightning_pool_slot(id uuid PRIMARY KEY,pool_session_id uuid,cluster_id uuid,player_id uuid,closed_at timestamptz,idle_since timestamptz);
CREATE TABLE lightning_pool_session(id uuid PRIMARY KEY,cluster_id uuid,cluster_epoch int,player_id uuid,anchor_seat_id uuid,cash_player_session_id uuid,exited_at timestamptz);
CREATE TABLE cash_player_session(id uuid PRIMARY KEY,closed_at timestamptz);
CREATE TABLE cash_cluster_epoch(cluster_id uuid,epoch int,ended_at timestamptz);
CREATE TABLE cash_cluster_events(game_id uuid,kind text,payload jsonb,cluster_epoch int);
CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
-- This boundary owns no physical tables. The real ruleset applier's selected
-- settings are checked independently by installed table readback at release.
CREATE FUNCTION fn_cash_apply_ruleset(uuid) RETURNS int LANGUAGE sql AS $$ SELECT 0 $$;
CREATE FUNCTION fn_lightning_anchor_is_live_eligible(uuid,uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
