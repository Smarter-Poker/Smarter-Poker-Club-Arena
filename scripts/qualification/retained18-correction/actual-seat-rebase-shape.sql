-- Actual typed current public.ca_seat_stack_rebases capture; native-only.
CREATE SEQUENCE IF NOT EXISTS public.ca_seat_stack_rebases_id_seq;
CREATE TABLE public.ca_seat_stack_rebases(
"id" bigint NOT NULL DEFAULT nextval('ca_seat_stack_rebases_id_seq'::regclass),
"settlement_id" uuid,
"table_id" uuid NOT NULL,
"hand_id" uuid NOT NULL,
"hand_number" bigint,
"user_id" uuid NOT NULL,
"engine_before" numeric NOT NULL,
"db_before" numeric NOT NULL,
"engine_after" numeric NOT NULL,
"written" numeric NOT NULL,
"amount" numeric GENERATED ALWAYS AS (db_before - engine_before) STORED,
"created_at" timestamp with time zone NOT NULL DEFAULT now()
);
