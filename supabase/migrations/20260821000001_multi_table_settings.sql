-- Roadmap batch 2 (Dan 2026-08-20): multi-table behavior toggles.
-- useUserTableSettings persists one column per setting via upsert, so each
-- new setting needs a real column. Both default TRUE (current behavior).
--
-- Tier 1 (additive, no data touched). Rollback: ALTER TABLE ... DROP COLUMN.

ALTER TABLE user_table_settings
  ADD COLUMN IF NOT EXISTS multi_auto_switch boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS multi_action_queue boolean NOT NULL DEFAULT true;
