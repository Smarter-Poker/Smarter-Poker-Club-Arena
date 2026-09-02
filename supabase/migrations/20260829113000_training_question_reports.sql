-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829113000; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- 20260829113000_training_question_reports.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER:        2
-- AUTHOR:      Codex
-- AFFECTS:     table: training_question_reports; RLS; index
-- IRREVERSIBLE: no
--
-- WHY:
--   Training questions need a durable, user-scoped reporting path so
--   wording, legality, answer, and visual defects can be audited instead
--   of disappearing into local UI state.
--
-- HOW (high level):
--   - Creates the report table and open-report lookup index.
--   - Allows authenticated users to insert and read only their reports.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN
DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'pre-flight failed: auth.users not found';
  END IF;
END $$
CREATE TABLE IF NOT EXISTS public.training_question_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  game_id text NOT NULL,
  question_id text NOT NULL,
  reason text NOT NULL CHECK (
    reason IN ('inaccurate_answer', 'unclear_wording', 'illegal_action', 'visual_mismatch')
  ),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution text,
  UNIQUE (user_id, game_id, question_id, reason)
)
CREATE INDEX IF NOT EXISTS training_question_reports_open_idx
  ON public.training_question_reports (game_id, question_id, created_at DESC)
  WHERE resolved_at IS NULL
ALTER TABLE public.training_question_reports ENABLE ROW LEVEL SECURITY
DROP POLICY IF EXISTS "Users read own training question reports"
  ON public.training_question_reports
CREATE POLICY "Users read own training question reports"
  ON public.training_question_reports
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id)
DROP POLICY IF EXISTS "Users insert own training question reports"
  ON public.training_question_reports
CREATE POLICY "Users insert own training question reports"
  ON public.training_question_reports
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id)
GRANT SELECT, INSERT ON public.training_question_reports TO authenticated
GRANT ALL ON public.training_question_reports TO service_role
COMMENT ON TABLE public.training_question_reports IS
  'Player-submitted quality reports tied to canonical Training Hub question ids.'
DO $$
BEGIN
  IF to_regclass('public.training_question_reports') IS NULL THEN
    RAISE EXCEPTION 'post-apply failed: training_question_reports not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'training_question_reports_open_idx'
      AND c.relkind = 'i'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: training question report index not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'training_question_reports'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'post-apply failed: RLS is not enabled on training_question_reports';
  END IF;
END $$
COMMIT
