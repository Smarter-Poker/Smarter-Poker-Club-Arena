-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260511165343 "training_rollups_20260511180000"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fe6aa878b6bede7dec143db52cf12019 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- TRAIN-DATA-ROLLUPS-1 part 1: rollup table + trigger + backfill
CREATE TABLE IF NOT EXISTS public.training_user_progress (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  total_sessions       integer NOT NULL DEFAULT 0,
  total_questions      integer NOT NULL DEFAULT 0,
  total_correct        integer NOT NULL DEFAULT 0,
  best_streak          integer NOT NULL DEFAULT 0,
  current_streak       integer NOT NULL DEFAULT 0,
  last_session_at      timestamptz,
  accuracy             numeric(5,2) GENERATED ALWAYS AS (
    CASE WHEN total_questions > 0
      THEN ROUND((total_correct::numeric / total_questions::numeric) * 100, 2)
      ELSE 0 END
  ) STORED,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS training_user_progress_accuracy_idx
  ON public.training_user_progress (accuracy DESC);

CREATE OR REPLACE FUNCTION public.tup_apply_session()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := NEW.user_id;
  v_qa   integer := COALESCE(NEW.questions_answered, 0);
  v_qc   integer := COALESCE(NEW.questions_correct, 0);
  v_streak integer := COALESCE(NEW.streak, 0);
BEGIN
  IF v_user IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.training_user_progress AS p (
    user_id, total_sessions, total_questions, total_correct,
    best_streak, current_streak, last_session_at, updated_at
  )
  VALUES (
    v_user, 1, v_qa, v_qc,
    v_streak, v_streak, COALESCE(NEW.session_timestamp, NEW.created_at, now()), now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    total_sessions   = p.total_sessions  + 1,
    total_questions  = p.total_questions + v_qa,
    total_correct    = p.total_correct   + v_qc,
    best_streak      = GREATEST(p.best_streak, v_streak),
    current_streak   = v_streak,
    last_session_at  = COALESCE(NEW.session_timestamp, NEW.created_at, now()),
    updated_at       = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tup_after_session_insert ON public.jarvis_training_sessions;
CREATE TRIGGER tup_after_session_insert
AFTER INSERT ON public.jarvis_training_sessions
FOR EACH ROW EXECUTE FUNCTION public.tup_apply_session();

INSERT INTO public.training_user_progress (
  user_id, total_sessions, total_questions, total_correct,
  best_streak, current_streak, last_session_at, updated_at
)
SELECT
  s.user_id,
  COUNT(*) AS total_sessions,
  SUM(COALESCE(s.questions_answered, 0))::integer,
  SUM(COALESCE(s.questions_correct, 0))::integer,
  COALESCE(MAX(s.streak), 0),
  0,
  MAX(COALESCE(s.session_timestamp, s.created_at)),
  now()
FROM public.jarvis_training_sessions s
WHERE s.user_id IS NOT NULL
GROUP BY s.user_id
ON CONFLICT (user_id) DO UPDATE SET
  total_sessions  = EXCLUDED.total_sessions,
  total_questions = EXCLUDED.total_questions,
  total_correct   = EXCLUDED.total_correct,
  best_streak     = GREATEST(public.training_user_progress.best_streak, EXCLUDED.best_streak),
  current_streak  = EXCLUDED.current_streak,
  last_session_at = EXCLUDED.last_session_at,
  updated_at      = now();

ALTER TABLE public.training_user_progress ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tup_self_read ON public.training_user_progress;
CREATE POLICY tup_self_read ON public.training_user_progress
  FOR SELECT USING (auth.uid() = user_id);
