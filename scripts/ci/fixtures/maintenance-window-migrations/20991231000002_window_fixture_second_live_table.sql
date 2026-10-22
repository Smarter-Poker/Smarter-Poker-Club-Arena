-- Fixture: a second queued window migration, installed by the daily installer.
-- @install-window: daily-maintenance
BEGIN;
ALTER TABLE public.hand_history ADD COLUMN window_fixture_marker integer;
COMMIT;
