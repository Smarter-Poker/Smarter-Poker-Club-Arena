\set ON_ERROR_STOP on
DO $assert_concurrency$
DECLARE
  v bigint;
BEGIN
  SELECT count(*) INTO v FROM public.rakeback_accrual_records
   WHERE rake_record_id IN (
     '50000000-0000-4000-8000-000000000401',
     '50000000-0000-4000-8000-000000000402'
   );
  IF v <> 2 THEN RAISE EXCEPTION 'concurrent sources produced % receipts', v; END IF;
  SELECT cents INTO v FROM public.rakeback_daily_user
   WHERE club_id = '10000000-0000-4000-8000-000000000002'
     AND day = '2026-09-08'
     AND user_id = '20000000-0000-4000-8000-000000000001';
  IF v <> 300 THEN RAISE EXCEPTION 'concurrent daily basis is %, expected 300', v; END IF;
  SELECT cents INTO v FROM public.rakeback_daily_user
   WHERE club_id = '10000000-0000-4000-8000-000000000002'
     AND day = '2026-09-08'
     AND user_id = '20000000-0000-4000-8000-000000000002';
  IF v <> 100 THEN RAISE EXCEPTION 'concurrent second-player basis is %, expected 100', v; END IF;
  SELECT rows_seen INTO v FROM public.rakeback_daily_state
   WHERE club_id = '10000000-0000-4000-8000-000000000002'
     AND day = '2026-09-08';
  IF v <> 4 THEN RAISE EXCEPTION 'concurrent day witness is %, expected 4', v; END IF;
END
$assert_concurrency$;
SELECT 'RAKEBACK_SOURCE_ACCRUAL_CONCURRENCY_OK' AS result;
