CREATE SCHEMA auth;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE TABLE profiles(id uuid PRIMARY KEY REFERENCES auth.users(id),is_horse boolean NOT NULL);
CREATE TABLE cash_games(id uuid PRIMARY KEY,enabled boolean,club_id uuid,variant text,sb numeric,bb numeric,opening_hold_since timestamptz);
CREATE TABLE cash_rejoin_constraints(player_id uuid,club_id uuid,variant text,sb numeric,bb numeric,barred_until timestamptz);
CREATE TABLE tables(id uuid PRIMARY KEY,name text,tournament_id uuid,max_players integer,current_players integer,
 cluster_id uuid REFERENCES cash_games(id),lifecycle text DEFAULT 'live',status text DEFAULT 'running',
 role text DEFAULT 'main',main_index integer DEFAULT 1,is_deleted boolean DEFAULT false,created_at timestamptz DEFAULT now());
CREATE TABLE table_seats(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),table_id uuid REFERENCES tables(id),user_id uuid REFERENCES profiles(id),left_at timestamptz,seat_number integer DEFAULT 1);
CREATE TABLE waitlist_policy(id boolean PRIMARY KEY CHECK(id),max_concurrent_holds integer NOT NULL CHECK(max_concurrent_holds>=0));
INSERT INTO waitlist_policy VALUES(true,1);
CREATE TABLE table_waitlist(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),table_id uuid REFERENCES tables(id),user_id uuid REFERENCES profiles(id) REFERENCES auth.users(id),
 status text NOT NULL CHECK(status IN('waiting','notified','seated','left','cleared','expired')),position integer DEFAULT 1,
 created_at timestamptz DEFAULT now(),notified_at timestamptz,hold_expires_at timestamptz);
CREATE UNIQUE INDEX table_waitlist_one_active_per_player_uidx ON table_waitlist(table_id,user_id) WHERE status IN('waiting','notified');
CREATE INDEX idx_waitlist_table_status ON table_waitlist(table_id,status);
CREATE INDEX idx_table_waitlist_user_id ON table_waitlist(user_id);
CREATE TABLE notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,type text,title text,message text,data jsonb);
CREATE TABLE cash_seat_moves(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),to_table_id uuid,state text,swap_move_id uuid);
CREATE TABLE cash_game_waitlist(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),game_id uuid,user_id uuid,status text,updated_at timestamptz,created_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX cash_game_waitlist_active ON cash_game_waitlist(game_id,user_id) WHERE status IN('waiting','notified');
