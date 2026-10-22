-- Fixture: a migration that needs ACCESS EXCLUSIVE on the three live tables,
-- the shape of the Midway rake-cap migration that could not install in play.
-- @install-window: daily-maintenance
BEGIN;
SET LOCAL lock_timeout = '1s';
LOCK TABLE public.clubs, public.tables, public.hand_history IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.clubs ADD COLUMN window_fixture_rake_cap numeric;
COMMIT;
