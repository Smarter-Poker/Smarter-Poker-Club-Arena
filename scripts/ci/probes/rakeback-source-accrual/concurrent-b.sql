\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.rake_records (
  id, hand_id, table_id, club_id, rake_amount, created_at,
  player_contributions, source, metadata, rake_method
) VALUES (
  '50000000-0000-4000-8000-000000000402',
  '40000000-0000-4000-8000-000000000402',
  '30000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002', 1.00,
  '2026-09-08 09:00:01+00',
  '{"20000000-0000-4000-8000-000000000002":10,"20000000-0000-4000-8000-000000000001":10}'::jsonb,
  'concurrent_probe_b', '{"hand_number":1000402}'::jsonb, 'DEALT_EQUAL'
);
COMMIT;
