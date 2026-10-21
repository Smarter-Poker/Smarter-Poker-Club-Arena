-- Isolated columns/storage for the captured current INSERT callback closure.
-- Original callback definitions are loaded unchanged. No callback is disabled.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_horse boolean DEFAULT false,ADD COLUMN IF NOT EXISTS role text DEFAULT 'user',ADD COLUMN IF NOT EXISTS mfa_required boolean DEFAULT false;
ALTER TABLE club_members ADD COLUMN IF NOT EXISTS is_bot boolean DEFAULT false,ADD COLUMN IF NOT EXISTS notes text,ADD COLUMN IF NOT EXISTS display_name text,ADD COLUMN IF NOT EXISTS nickname text,ADD COLUMN IF NOT EXISTS joined_at timestamptz DEFAULT now(),ADD COLUMN IF NOT EXISTS last_active_at timestamptz;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS is_platform boolean DEFAULT false,ADD COLUMN IF NOT EXISTS is_union boolean DEFAULT false,ADD COLUMN IF NOT EXISTS union_id uuid,ADD COLUMN IF NOT EXISTS updated_at timestamptz,ADD COLUMN IF NOT EXISTS member_count integer,ADD COLUMN IF NOT EXISTS level smallint,ADD COLUMN IF NOT EXISTS player_level smallint,ADD COLUMN IF NOT EXISTS player_threshold_current integer,ADD COLUMN IF NOT EXISTS player_threshold_next integer,ADD COLUMN IF NOT EXISTS admin_count integer,ADD COLUMN IF NOT EXISTS super_agent_count integer,ADD COLUMN IF NOT EXISTS agent_count integer,ADD COLUMN IF NOT EXISTS hierarchy_units numeric,ADD COLUMN IF NOT EXISTS hierarchy_units_rounded_up integer,ADD COLUMN IF NOT EXISTS hierarchy_level integer,ADD COLUMN IF NOT EXISTS hierarchy_threshold_current numeric,ADD COLUMN IF NOT EXISTS hierarchy_threshold_next numeric,ADD COLUMN IF NOT EXISTS requires_approval boolean DEFAULT false;
ALTER TABLE union_clubs ADD COLUMN IF NOT EXISTS joined_at timestamptz;
ALTER TABLE accounting_agreement_history ADD COLUMN IF NOT EXISTS club_id uuid,ADD COLUMN IF NOT EXISTS subject_user_id uuid,ADD COLUMN IF NOT EXISTS event_type text,ADD COLUMN IF NOT EXISTS actor_id uuid,ADD COLUMN IF NOT EXISTS before_terms jsonb;
CREATE SEQUENCE historical_wallet_history_id START 1000;
ALTER TABLE accounting_agreement_history ALTER COLUMN id SET DEFAULT nextval('historical_wallet_history_id'),ALTER COLUMN observed_at SET DEFAULT clock_timestamp();
CREATE TABLE club_messenger_admissions(club_id uuid,user_id uuid,active boolean,generation uuid DEFAULT gen_random_uuid(),transaction_id bigint,started_at timestamptz,PRIMARY KEY(club_id,user_id));
CREATE TABLE club_messenger_staff_notice_groups(club_id uuid,conversation_id uuid);
CREATE TABLE game_management_events(id bigserial PRIMARY KEY,event_type text,scope_kind text,scope_id uuid,club_id uuid,union_id uuid,recipient_id uuid,entity_type text,entity_id uuid,command_id uuid,actor_id uuid,payload jsonb);
CREATE TABLE ca_private_record_transport_state(singleton boolean PRIMARY KEY,supabase_enabled boolean);
INSERT INTO ca_private_record_transport_state VALUES(true,false);

CREATE TABLE club_display_member_boost(club_id uuid PRIMARY KEY,boost bigint DEFAULT 0);
-- Two explicit isolated ladder configuration rows; member count must remain
-- unchanged because the recovered wallet is departed, at every threshold.
CREATE TABLE club_level_thresholds(level smallint PRIMARY KEY,min_members integer);
INSERT INTO club_level_thresholds VALUES(1,0),(2,10);
