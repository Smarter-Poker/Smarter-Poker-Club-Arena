\set ON_ERROR_STOP on
SET application_name = 'rakeback_close_accrual_b';
DO $race$
BEGIN
  BEGIN
    INSERT INTO public.rake_records (
      id, hand_id, table_id, club_id, rake_amount, created_at,
      player_contributions, source, metadata, rake_method
    ) VALUES (
      '50000000-0000-4000-8000-000000000902',
      '40000000-0000-4000-8000-000000000902',
      '30000000-0000-4000-8000-000000000009',
      '10000000-0000-4000-8000-000000000010', 1.00,
      '2026-09-08 15:00:01+00',
      '{"20000000-0000-4000-8000-000000000011":10}'::jsonb,
      'close_accrual_loser', '{"hand_number":900902}'::jsonb,
      'DEALT_EQUAL'
    );
    RAISE EXCEPTION 'RACE_FAILED accrual crossed a concurrent close';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RACE_FAILED accrual crossed a concurrent close' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%immutable closed rakeback period%' THEN RAISE; END IF;
  END;
END
$race$;
