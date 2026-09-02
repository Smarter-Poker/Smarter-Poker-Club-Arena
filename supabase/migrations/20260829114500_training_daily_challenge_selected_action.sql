-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829114500; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- 20260829114500_training_daily_challenge_selected_action.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER:        2
-- AUTHOR:      Codex
-- AFFECTS:     table: training_daily_challenge
-- IRREVERSIBLE: no
--
-- WHY:
--   A completed Daily Challenge must render the answer the player actually
--   chose across browsers and devices; localStorage cannot provide that.
--
-- HOW (high level):
--   - Adds an optional selected_action field to existing challenge rows.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN
DO $$
BEGIN
  IF to_regclass('public.training_daily_challenge') IS NULL THEN
    RAISE EXCEPTION 'pre-flight failed: public.training_daily_challenge not found';
  END IF;
END $$
ALTER TABLE public.training_daily_challenge
  ADD COLUMN IF NOT EXISTS selected_action text
COMMENT ON COLUMN public.training_daily_challenge.selected_action IS
  'The user-facing answer text selected for this daily challenge attempt.'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'training_daily_challenge'
      AND column_name = 'selected_action'
      AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: training_daily_challenge.selected_action not found';
  END IF;
END $$
COMMIT
