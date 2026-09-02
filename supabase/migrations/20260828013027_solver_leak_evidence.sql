-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828013027; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Deterministic Leak Finder evidence contract.
ALTER TABLE public.training_answers
  ADD COLUMN IF NOT EXISTS submission_id text,
  ADD COLUMN IF NOT EXISTS solver_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS solver_source text,
  ADD COLUMN IF NOT EXISTS selected_frequency numeric(6,2),
  ADD COLUMN IF NOT EXISTS optimal_frequency numeric(6,2),
  ADD COLUMN IF NOT EXISTS ev_loss_measured boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS evidence_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'training_answers_user_submission_key'
      AND conrelid = 'public.training_answers'::regclass
  ) THEN
    ALTER TABLE public.training_answers
      ADD CONSTRAINT training_answers_user_submission_key UNIQUE (user_id, submission_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_training_answers_user_answered
  ON public.training_answers (user_id, answered_at DESC);

CREATE INDEX IF NOT EXISTS idx_training_answers_verified_user_answered
  ON public.training_answers (user_id, answered_at DESC)
  WHERE solver_verified = true;

COMMENT ON COLUMN public.training_answers.solver_verified IS
  'True only when /api/training/record-question regraded the answer from the canonical server-side training_question_cache row.';

COMMENT ON COLUMN public.training_answers.ev_loss_measured IS
  'True only when both selected and optimal actions carried exact per-action solver EVs. False means ev_loss must not be presented as measured solver loss.';
