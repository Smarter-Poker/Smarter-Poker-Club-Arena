-- Recorded production arrival receipt column types, isolated native catalog only.
CREATE TABLE public.tournament_seat_move_receipts(request_id uuid,tournament_id uuid,user_id uuid,source_table_id uuid,destination_table_id uuid,source_seat_id uuid,destination_seat_id uuid,source_seat_number integer,destination_seat_number integer,source_mode text,stack numeric,moved_at timestamptz);
