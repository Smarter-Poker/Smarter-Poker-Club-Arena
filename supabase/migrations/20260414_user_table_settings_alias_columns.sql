-- ═══════════════════════════════════════════════════════════════════════════════
-- Bible V8 §11.1.1 — user_table_settings alias columns
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Adds the two alias-related columns that the client hook
-- (src/hooks/useUserTableSettings.ts) expects but were missing from the
-- table. The hook's upserts to these columns silently no-op'd before this
-- migration (Supabase returned success with the payload dropped).
--
--   use_alias   (boolean) — display club alias instead of smarter.poker name
--   table_alias (text)    — the alias text itself
--
-- DEFAULT_USER_TABLE_SETTINGS in the hook:
--   use_alias:   false
--   table_alias: ''
--
-- Discovered 2026-04-14 during the STEP 8 / Chapter 11 wiring audit.
-- See skills/bible-v8/COMPLIANCE-TRACKER.md — Ch 11.

BEGIN;

ALTER TABLE public.user_table_settings
  ADD COLUMN IF NOT EXISTS use_alias boolean NOT NULL DEFAULT false;

ALTER TABLE public.user_table_settings
  ADD COLUMN IF NOT EXISTS table_alias text NOT NULL DEFAULT '';

COMMIT;

-- Verification (run manually if desired — not part of the migration):
--   SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'user_table_settings'
--     AND column_name IN ('use_alias', 'table_alias');
