BEGIN;
SET LOCAL lock_timeout = '2s';
CREATE INDEX IF NOT EXISTS idx_ca_arena_settings_club_id_fk ON public.ca_arena_settings (club_id);
COMMIT;
