-- Native dependency shape; exact installed F06/lease/hook/outer-settlement bodies
-- are loaded separately. This fixture never claims a qualified financial payout.
CREATE SCHEMA smarter_private;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS
 $$ SELECT current_setting('request.jwt.claims',true)::jsonb->>'role' $$;
CREATE TABLE public.ca_declared_money_triggers(table_name text,trigger_name text,note text,PRIMARY KEY(table_name,trigger_name));
CREATE TABLE public.tournaments(id uuid PRIMARY KEY,status text,format_contract text,table_size integer,current_players integer);
CREATE TABLE public.tables(id uuid PRIMARY KEY,tournament_id uuid,status text,is_deleted boolean DEFAULT false,lifecycle text);
CREATE TABLE public.table_seats(id uuid PRIMARY KEY,table_id uuid,user_id uuid,seat_number integer,stack numeric,
 left_at timestamptz,terminal_closed_at timestamptz,occupancy_id uuid);
CREATE TABLE public.tournament_players(id uuid PRIMARY KEY,tournament_id uuid,table_id uuid,user_id uuid,
 seat_number integer,chips numeric,status text);
CREATE TABLE public.engine_tournament_leases(tournament_id uuid PRIMARY KEY,instance_id text,engine_version text,
 acquired_at timestamptz,heartbeat_at timestamptz,lease_generation uuid NOT NULL DEFAULT gen_random_uuid(),protocol_version integer DEFAULT 1);
CREATE TABLE public.hand_atomic_commits(table_id uuid,hand_number bigint,hand_id uuid,post_commit_completed_at timestamptz);
CREATE TABLE public.hand_history(id uuid DEFAULT gen_random_uuid(),table_id uuid,hand_number bigint);
CREATE TABLE public.hand_private_state(table_id uuid,hand_number integer);
CREATE TABLE public.tournament_seat_move_receipts(request_id uuid);
CREATE TABLE public.hand_state_snapshots(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),table_id uuid,hand_number integer,
 state_json jsonb,config_json jsonb DEFAULT '{}',dealer_seat integer DEFAULT 1,players_json jsonb DEFAULT '[]',
 stage text DEFAULT 'preflop',is_complete boolean DEFAULT false,created_at timestamptz DEFAULT now(),
 updated_at timestamptz DEFAULT now(),pending_deadlines jsonb DEFAULT '[]',disconnect_states jsonb DEFAULT '{}');
CREATE UNIQUE INDEX one_active_snapshot ON public.hand_state_snapshots(table_id) WHERE NOT is_complete;
CREATE TABLE public.fixture_ledger(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),amount numeric);
CREATE TABLE public.engine_maintenance_break(enforce_freeze boolean,announced_at timestamptz,
 phase text,break_started_at timestamptz,break_ends_at timestamptz);
CREATE TABLE public.engine_maintenance_thaws(contract_version integer,release_target_at timestamptz,shifted jsonb);
INSERT INTO public.fixture_ledger(amount) VALUES(10),(20);
