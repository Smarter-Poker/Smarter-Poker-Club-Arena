\set ON_ERROR_STOP on

BEGIN;
SELECT set_config('request.headers', '{}', true);
SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);
SELECT set_config('request.method', 'POST', true);
SELECT set_config('request.path', '/tables', true);
SET LOCAL ROLE authenticated;
SELECT smarter_private.fn_smarter_data_api_pre_request();
INSERT INTO public.tables (
  id,
  tournament_id,
  status,
  current_players,
  max_players
) VALUES (
  '20000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000003',
  'running',
  0,
  9
);
COMMIT;
