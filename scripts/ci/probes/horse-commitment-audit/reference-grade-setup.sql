-- Disposable fixture only (job 8, reference grade). Loaded after the job-7
-- chain (selection-setup.sql, 20261007075304, roster-basis-setup.sql and
-- 20261008041707) and BEFORE
-- 20261024225914_horse_commitment_review_grades_against_the_solver_charts.sql,
-- whose preimage requires the solver chart source it grades against.
-- memory_charts_gold copies the live column list (supabase-columns-manifest:
-- chart_id, game_type, stack_depth, hero_position, villain_action,
-- hand_matrix, created_at) with RLS on and no API grants. Its rows are
-- inserted by reference-grade.sql inside its own rolled-back transaction.
-- No production object, credential or connection is involved.
CREATE TABLE public.memory_charts_gold (
  chart_id text,
  game_type text NOT NULL,
  stack_depth integer NOT NULL,
  hero_position text NOT NULL,
  villain_action text NOT NULL,
  hand_matrix jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.memory_charts_gold ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_charts_gold FROM PUBLIC,anon,authenticated,service_role;
