-- Additional isolated schema for the exact installed move and swap bodies.
ALTER TABLE tables ADD COLUMN name text;
ALTER TABLE tables ADD COLUMN main_index integer;
ALTER TABLE tables ADD COLUMN max_players integer DEFAULT 9;
ALTER TABLE table_seats ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE table_seats ADD COLUMN member_id uuid;
ALTER TABLE table_seats ADD COLUMN sit_out_at timestamptz;
ALTER TABLE table_seats ADD COLUMN is_away boolean DEFAULT false;
ALTER TABLE table_seats ADD COLUMN horse_id uuid;
ALTER TABLE table_seats ADD COLUMN auto_rebuy boolean DEFAULT false;
ALTER TABLE table_seats ADD COLUMN time_bank_remaining numeric;
ALTER TABLE table_seats ADD COLUMN time_bank_uses_remaining integer;
ALTER TABLE table_seats ADD COLUMN entry_hold text;
ALTER TABLE table_seats ADD COLUMN entry_post_agreed boolean;
CREATE TABLE cash_seat_moves(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),game_id uuid NOT NULL,player_id uuid NOT NULL,
 from_table_id uuid NOT NULL,to_table_id uuid NOT NULL,reason text NOT NULL,
 state text NOT NULL DEFAULT 'pending',created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,executed_at timestamptz,to_seat_number integer,note text,
 announced_at timestamptz,swap_move_id uuid,ready_at timestamptz
);
CREATE TABLE cash_player_session(player_id uuid,scope_type text,scope_id uuid,table_id uuid,closed_at timestamptz);
CREATE TABLE cash_cluster_events(game_id uuid,table_id uuid,kind text,payload jsonb);
CREATE FUNCTION fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT fn_platform_frozen()$$;

ALTER TABLE cash_seat_moves ADD FOREIGN KEY(from_table_id) REFERENCES tables(id) ON DELETE CASCADE;
ALTER TABLE cash_seat_moves ADD FOREIGN KEY(to_table_id) REFERENCES tables(id) ON DELETE CASCADE;
ALTER TABLE cash_seat_moves ADD FOREIGN KEY(game_id) REFERENCES cash_games(id) ON DELETE CASCADE;
ALTER TABLE cash_seat_moves ADD CHECK(reason IN('must_move','break','seat_change','balance'));
ALTER TABLE cash_seat_moves ADD CHECK(state IN('pending','done','cancelled','expired'));
CREATE UNIQUE INDEX cash_seat_moves_one_pending_per_player ON cash_seat_moves(player_id) WHERE state='pending';
