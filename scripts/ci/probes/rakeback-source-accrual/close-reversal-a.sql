\set ON_ERROR_STOP on
SET application_name = 'rakeback_close_reversal_a';
BEGIN;
SELECT public.fn_close_settlement_period(id)
  FROM public.rakeback_periods
 WHERE club_id = '10000000-0000-4000-8000-000000000011'
   AND user_id = '20000000-0000-4000-8000-000000000012'
   AND period_start = '2026-09-07';
SELECT pg_sleep(1);
COMMIT;
