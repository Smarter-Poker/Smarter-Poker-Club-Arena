-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260511165356 "training_leaderboard_mv_20260511180100"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0c2c94b417d9c58ac2d95f818dc64d7c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- TRAIN-DATA-ROLLUPS-1 part 2: leaderboard materialized view + refresh RPC
DROP MATERIALIZED VIEW IF EXISTS public.training_leaderboard_top;
CREATE MATERIALIZED VIEW public.training_leaderboard_top AS
SELECT
  ROW_NUMBER() OVER (ORDER BY p.accuracy DESC, p.total_correct DESC, p.user_id) AS rank,
  p.user_id,
  p.accuracy,
  p.total_correct,
  p.total_questions,
  p.total_sessions,
  p.best_streak,
  p.last_session_at
FROM public.training_user_progress p
WHERE p.total_questions >= 25
ORDER BY p.accuracy DESC, p.total_correct DESC
LIMIT 500;

CREATE UNIQUE INDEX IF NOT EXISTS training_leaderboard_top_rank_idx
  ON public.training_leaderboard_top (rank);
CREATE INDEX IF NOT EXISTS training_leaderboard_top_user_idx
  ON public.training_leaderboard_top (user_id);

CREATE OR REPLACE FUNCTION public.training_leaderboard_refresh()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.training_leaderboard_top;
END;
$$;

GRANT SELECT ON public.training_leaderboard_top TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.training_leaderboard_refresh() TO authenticated;
