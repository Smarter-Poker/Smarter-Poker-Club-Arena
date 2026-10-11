-- Isolated obligation stores read by the actual production deletion guard.
-- Amounts and statuses are explicit inputs, not substitutes for cashout writers.
CREATE TABLE table_seats(table_id uuid,user_id uuid,stack numeric,left_at timestamptz);
CREATE TABLE tournaments(id uuid PRIMARY KEY,status text);
CREATE TABLE tournament_players(tournament_id uuid,user_id uuid,status text);
CREATE TABLE cashout_requests(player_id uuid,agent_id uuid,amount numeric,status text,completed_at timestamptz);
CREATE TABLE chip_escrow(player_id uuid,amount numeric,released_at timestamptz);
CREATE TABLE chip_escrow_holds(user_id uuid,status text);
INSERT INTO profiles VALUES('00000000-0000-0000-0000-000000000010','active','custody-player');
INSERT INTO club_members(club_id,user_id,role,status,chip_balance)
VALUES('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000010','player','approved',11.11);
CREATE TABLE chip_requests(requester_id uuid,approver_id uuid,status text);
ALTER TABLE club_members ADD COLUMN promo_balance numeric DEFAULT 0, ADD COLUMN credit_used numeric DEFAULT 0, ADD COLUMN diamonds numeric DEFAULT 0;
