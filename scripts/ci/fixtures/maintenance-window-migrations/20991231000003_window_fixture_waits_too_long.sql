-- Fixture: breaks the window rules (a 5 s lock_timeout would queue behind
-- live work), so the installer must refuse it before it waits for the break.
-- @install-window: daily-maintenance
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.tables ADD COLUMN window_fixture_never integer;
COMMIT;
