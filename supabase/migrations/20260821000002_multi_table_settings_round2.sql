-- 2026-08-21: desktop turn alerts + shared-socket beta toggles.
-- useUserTableSettings persists one column per setting via upsert.
-- Both default FALSE: notifications must be opted into (the toggle is the
-- permission-request gesture), and the shared socket is a beta soak.
--
-- Tier 1 (additive). Rollback: ALTER TABLE ... DROP COLUMN.

ALTER TABLE user_table_settings
  ADD COLUMN IF NOT EXISTS multi_desktop_alerts boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS multi_shared_socket boolean NOT NULL DEFAULT false;
