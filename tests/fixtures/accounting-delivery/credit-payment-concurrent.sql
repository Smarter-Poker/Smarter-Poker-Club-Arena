SELECT set_config('test.uid','10000000-0000-0000-0000-000000000002',false);
SELECT set_config('test.engine','false',false);
BEGIN;
SELECT fn_process_credit_invoice_payment('70000000-0000-0000-0000-000000000002',5.04,'wallet','80000000-0000-0000-0000-000000000099');
-- Keep the transaction open so an overlapping retry exercises the lock.
SELECT pg_sleep(0.25);
COMMIT;
