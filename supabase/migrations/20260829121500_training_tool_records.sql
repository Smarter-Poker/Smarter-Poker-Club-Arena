-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829121500; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- 20260829121500_training_tool_records.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER:        2
-- AUTHOR:      Codex
-- AFFECTS:     table: training_tool_records; RLS; index
-- IRREVERSIBLE: no
--
-- WHY:
--   Non-graded tools need durable state without creating fake completed
--   poker sessions or contaminating accuracy, streak, reward, and ranking
--   aggregates.
--
-- HOW (high level):
--   - Creates a user/tool/key record store with a bounded API payload.
--   - Restricts every operation to the authenticated record owner.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN
DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'pre-flight failed: auth.users not found';
  END IF;
END $$
CREATE TABLE IF NOT EXISTS public.training_tool_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tool_id text NOT NULL CHECK (char_length(tool_id) BETWEEN 1 AND 80),
  record_type text NOT NULL DEFAULT 'state' CHECK (char_length(record_type) BETWEEN 1 AND 80),
  record_key text NOT NULL CHECK (char_length(record_key) BETWEEN 1 AND 160),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tool_id, record_key)
)
CREATE INDEX IF NOT EXISTS training_tool_records_user_tool_updated_idx
  ON public.training_tool_records (user_id, tool_id, updated_at DESC)
ALTER TABLE public.training_tool_records ENABLE ROW LEVEL SECURITY
DROP POLICY IF EXISTS training_tool_records_select_own ON public.training_tool_records
CREATE POLICY training_tool_records_select_own
  ON public.training_tool_records FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id)
DROP POLICY IF EXISTS training_tool_records_insert_own ON public.training_tool_records
CREATE POLICY training_tool_records_insert_own
  ON public.training_tool_records FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id)
DROP POLICY IF EXISTS training_tool_records_update_own ON public.training_tool_records
CREATE POLICY training_tool_records_update_own
  ON public.training_tool_records FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id)
DROP POLICY IF EXISTS training_tool_records_delete_own ON public.training_tool_records
CREATE POLICY training_tool_records_delete_own
  ON public.training_tool_records FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.training_tool_records TO authenticated
GRANT ALL ON public.training_tool_records TO service_role
DO $$
BEGIN
  IF to_regclass('public.training_tool_records') IS NULL THEN
    RAISE EXCEPTION 'post-apply failed: training_tool_records not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'training_tool_records_user_tool_updated_idx'
      AND c.relkind = 'i'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: training tool records index not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'training_tool_records'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'post-apply failed: RLS is not enabled on training_tool_records';
  END IF;
END $$
COMMIT
