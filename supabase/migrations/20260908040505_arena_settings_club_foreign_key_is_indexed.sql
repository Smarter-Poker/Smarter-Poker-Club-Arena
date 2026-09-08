-- F53: CI found ca_arena_settings.club_id had no usable foreign-key index.
-- Verified live: one row, 32 kB total relation size, only the id primary key.
-- Index the original relationship so club deletion need not scan this child.
-- No rows, balances, permissions, or foreign-key semantics change.
BEGIN;
SET LOCAL lock_timeout = '3s';
CREATE INDEX IF NOT EXISTS idx_ca_arena_settings_club_id_fk
  ON public.ca_arena_settings (club_id);
COMMIT;
