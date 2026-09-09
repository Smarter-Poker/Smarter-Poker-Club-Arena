\set ON_ERROR_STOP on
DO $assert_close_races$
DECLARE
  v bigint;
  n numeric;
  t text;
BEGIN
  SELECT status, rake_generated INTO t, n FROM public.rakeback_periods
   WHERE club_id = '10000000-0000-4000-8000-000000000010'
     AND user_id = '20000000-0000-4000-8000-000000000011'
     AND period_start = '2026-09-07';
  IF t <> 'paid' OR n <> 1 THEN
    RAISE EXCEPTION 'close-vs-accrual winner is status %, basis %', t, n;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.rake_records
     WHERE id = '50000000-0000-4000-8000-000000000902'
  ) THEN
    RAISE EXCEPTION 'losing concurrent accrual source committed';
  END IF;

  SELECT status, rake_generated INTO t, n FROM public.rakeback_periods
   WHERE club_id = '10000000-0000-4000-8000-000000000011'
     AND user_id = '20000000-0000-4000-8000-000000000012'
     AND period_start = '2026-09-07';
  IF t <> 'paid' OR n <> 1 THEN
    RAISE EXCEPTION 'close-vs-reversal mutated paid history: status %, basis %', t, n;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.rake_records
     WHERE id = '50000000-0000-4000-8000-000000000911'
  ) THEN
    RAISE EXCEPTION 'concurrent lawful DELETE refund did not commit';
  END IF;
  SELECT cents INTO v FROM public.rakeback_closed_period_offsets
   WHERE original_rake_record_id = '50000000-0000-4000-8000-000000000911'
     AND user_id = '20000000-0000-4000-8000-000000000012';
  IF v <> 100 THEN
    RAISE EXCEPTION 'close-vs-reversal open-period offset is %, expected 100', v;
  END IF;
END
$assert_close_races$;
SELECT 'RAKEBACK_SOURCE_ACCRUAL_CLOSE_RACES_OK' AS result;
