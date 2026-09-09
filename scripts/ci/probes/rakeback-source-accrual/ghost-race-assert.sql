\set ON_ERROR_STOP on
DO $assert_ghost_race$
DECLARE
  v bigint;
BEGIN
  SELECT cents INTO v FROM public.rakeback_daily_user
   WHERE club_id = '10000000-0000-4000-8000-000000000012'
     AND day = '2026-09-08'
     AND user_id = '20000000-0000-4000-8000-000000000013';
  IF v <> 125 THEN
    RAISE EXCEPTION 'concurrent null/canonical basis is %, expected 125', v;
  END IF;
  SELECT rows_seen INTO v FROM public.rakeback_daily_state
   WHERE club_id = '10000000-0000-4000-8000-000000000012'
     AND day = '2026-09-08';
  IF v <> 1 THEN
    RAISE EXCEPTION 'concurrent null/canonical witness is %, expected 1', v;
  END IF;
  SELECT count(*) INTO v FROM public.rakeback_source_supersessions
   WHERE ghost_rake_record_id = '50000000-0000-4000-8000-000000000951'
     AND canonical_rake_record_id = '50000000-0000-4000-8000-000000000952'
     AND rake_cents = 125;
  IF v <> 1 THEN
    RAISE EXCEPTION 'concurrent null/canonical source has no exact supersession';
  END IF;
  SELECT count(*) INTO v FROM public.rakeback_accrual_reversals
   WHERE rake_record_id = '50000000-0000-4000-8000-000000000951'
     AND reason = 'superseded_ghost_twin'
     AND reversed_cents = 125;
  IF v <> 1 THEN
    RAISE EXCEPTION 'concurrent null source has no exact reversal';
  END IF;
  SELECT count(*) INTO v FROM public.rakeback_accrual_records
   WHERE rake_record_id IN (
     '50000000-0000-4000-8000-000000000951',
     '50000000-0000-4000-8000-000000000952'
   );
  IF v <> 2 THEN
    RAISE EXCEPTION 'concurrent null/canonical identities have % receipts, expected 2', v;
  END IF;
END
$assert_ghost_race$;
SELECT 'RAKEBACK_SOURCE_ACCRUAL_GHOST_RACE_OK' AS result;
