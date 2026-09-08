\set ON_ERROR_STOP on

BEGIN;
UPDATE public.tournament_players
   SET status = 'eliminated'
 WHERE tournament_id = '10000000-0000-4000-8000-000000000001'
   AND user_id = '30000000-0000-4000-8000-000000000001';
COMMIT;
