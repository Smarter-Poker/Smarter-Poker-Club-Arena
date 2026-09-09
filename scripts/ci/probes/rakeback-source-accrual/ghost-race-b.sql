\set ON_ERROR_STOP on
SET application_name = 'rakeback_ghost_race_b';
INSERT INTO public.rake_records (
  id, hand_id, table_id, club_id, rake_amount, created_at,
  player_contributions, source, metadata, rake_method
) VALUES (
  '50000000-0000-4000-8000-000000000952',
  '40000000-0000-4000-8000-000000000952',
  '30000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000012', 1.25,
  '2026-09-08 16:00:01+00',
  '{"20000000-0000-4000-8000-000000000013":10}'::jsonb,
  'concurrent_linked_second', '{"hand_number":1000951}'::jsonb,
  'DEALT_EQUAL'
);
