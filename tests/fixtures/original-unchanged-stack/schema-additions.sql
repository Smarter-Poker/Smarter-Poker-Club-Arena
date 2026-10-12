CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
ALTER TABLE cash_seat_move_receipts ADD game_id uuid,ADD club_id uuid,ADD from_seat_number integer,ADD to_seat_number integer,ADD transaction_id xid8,ADD receipt jsonb;
