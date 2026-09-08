\set ON_ERROR_STOP on

BEGIN;
INSERT INTO public.table_seats (
  table_id, user_id, seat_number, stack, left_at
) VALUES (
  '20000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  1, 1000, NULL
);
SELECT pg_advisory_lock(9080220);
SELECT pg_sleep(3);
SELECT pg_advisory_unlock(9080220);
COMMIT;
