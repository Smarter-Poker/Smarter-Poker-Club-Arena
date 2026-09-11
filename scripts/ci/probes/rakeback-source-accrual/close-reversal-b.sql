\set ON_ERROR_STOP on
SET application_name = 'rakeback_close_reversal_b';
DELETE FROM public.rake_records
 WHERE id = '50000000-0000-4000-8000-000000000911';
