-- Synthetic local-only committed baseline in a separate disposable database,
-- BEFORE migration 20260921202834: one day settled under the pre-burn contract
-- (paid in full) and one older day still open, the shape production held on
-- 2026-09-21 (one settled day, one open day). The migration must apply over
-- both without rewriting either.
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL "request.jwt.claims"='{"role":"service_role"}';
SELECT public.deduct_diamonds('d1000000-0000-4000-8000-000000000005',200,
 'Isolated Legacy Entry','test_entry','diamond_game',
 '{"recipient_id":"d1000000-0000-4000-8000-000000000002"}','burn-legacy:entry',0);
SELECT public.fn_diamond_spin_book('d1000000-0000-4000-8000-000000000002',
 'd1000000-0000-4000-8000-000000000003','d1000000-0000-4000-8000-000000000003','club',
 'd1000000-0000-4000-8000-000000000005','entry',100,'burn-legacy:settled-intake','Isolated Legacy Settled Entry',
 (clock_timestamp() AT TIME ZONE 'America/Chicago')::date-1);
SELECT public.fn_diamond_spin_book('d1000000-0000-4000-8000-000000000002',
 'd1000000-0000-4000-8000-000000000003','d1000000-0000-4000-8000-000000000003','club',
 'd1000000-0000-4000-8000-000000000005','entry',100,'burn-legacy:open-intake','Isolated Legacy Open Entry',
 (clock_timestamp() AT TIME ZONE 'America/Chicago')::date-2);
SELECT public.fn_diamond_spin_settle_day('d1000000-0000-4000-8000-000000000002',(clock_timestamp() AT TIME ZONE 'America/Chicago')::date-1);
COMMIT;
