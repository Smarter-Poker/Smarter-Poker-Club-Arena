-- Synthetic local-only committed baseline in a separate disposable database.
-- True duplicate-commit races cannot be observed across two rollback-only sessions.
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL "request.jwt.claims"='{"role":"service_role"}';
SELECT public.deduct_diamonds('d1000000-0000-4000-8000-000000000005',100,
 'Isolated Concurrent Entry','test_entry','diamond_game',
 '{"recipient_id":"d1000000-0000-4000-8000-000000000002"}','custody-race:entry',0);
SELECT public.fn_diamond_spin_book('d1000000-0000-4000-8000-000000000002',
 'd1000000-0000-4000-8000-000000000003','d1000000-0000-4000-8000-000000000003','club',
 'd1000000-0000-4000-8000-000000000005','entry',100,'custody-race:intake','Isolated Concurrent Entry',
 (clock_timestamp() AT TIME ZONE 'America/Chicago')::date-1);
COMMIT;
