-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260507172220 "memory_dashboard_rpc_streak_fix"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 17b222cf6deeb907bd60def23c7df013 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Patch: defend against NULL streak fields when user_daily_streaks has no row for the user.
-- SELECT INTO with zero matches sets the destination variables to NULL, overriding the
-- :=0 defaults. Coalesce after the SELECT INTO so the JSON contract stays integer-valued.

CREATE OR REPLACE FUNCTION public.rpc_memory_dashboard(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  this_week_start  timestamptz := date_trunc('week', now());
  last_week_start  timestamptz := date_trunc('week', now()) - interval '7 days';
  last_week_end    timestamptz := date_trunc('week', now());
  rolling_30_start timestamptz := now() - interval '30 days';

  this_sessions  int := 0;
  this_avg_acc   numeric := 0;
  this_diamonds  int := 0;
  last_sessions  int := 0;
  last_avg_acc   numeric := 0;

  rolling_avg_acc numeric := 0;
  rolling_n       int := 0;
  cur_grade       text;
  next_grade      text;

  cur_streak  int;
  best_streak int;
  total_days  int;

  per_mode    jsonb := '[]'::jsonb;
  per_level   jsonb := '[]'::jsonb;
  mastered_count int := 0;

  dc_row       record;
  dc_completed boolean := false;

  result jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id required';
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT
    coalesce(count(*), 0)::int,
    coalesce(avg(accuracy), 0)::numeric,
    coalesce(sum(diamonds_earned), 0)::int
  INTO this_sessions, this_avg_acc, this_diamonds
  FROM memory_game_sessions
  WHERE user_id = p_user_id
    AND created_at >= this_week_start;

  SELECT
    coalesce(count(*), 0)::int,
    coalesce(avg(accuracy), 0)::numeric
  INTO last_sessions, last_avg_acc
  FROM memory_game_sessions
  WHERE user_id = p_user_id
    AND created_at >= last_week_start
    AND created_at <  last_week_end;

  SELECT
    coalesce(avg(accuracy), 0)::numeric,
    coalesce(count(*), 0)::int
  INTO rolling_avg_acc, rolling_n
  FROM memory_game_sessions
  WHERE user_id = p_user_id
    AND created_at >= rolling_30_start;

  cur_grade := CASE
    WHEN rolling_avg_acc * 100 >= 95 THEN 'A+'
    WHEN rolling_avg_acc * 100 >= 90 THEN 'A'
    WHEN rolling_avg_acc * 100 >= 85 THEN 'B+'
    WHEN rolling_avg_acc * 100 >= 80 THEN 'B'
    WHEN rolling_avg_acc * 100 >= 75 THEN 'C+'
    WHEN rolling_avg_acc * 100 >= 70 THEN 'C'
    WHEN rolling_avg_acc * 100 >= 65 THEN 'D+'
    WHEN rolling_avg_acc * 100 >= 60 THEN 'D'
    ELSE 'F'
  END;
  next_grade := CASE
    WHEN rolling_avg_acc * 100 >= 95 THEN NULL
    WHEN rolling_avg_acc * 100 >= 90 THEN 'A+'
    WHEN rolling_avg_acc * 100 >= 85 THEN 'A'
    WHEN rolling_avg_acc * 100 >= 80 THEN 'B+'
    WHEN rolling_avg_acc * 100 >= 75 THEN 'B'
    WHEN rolling_avg_acc * 100 >= 70 THEN 'C+'
    WHEN rolling_avg_acc * 100 >= 65 THEN 'C'
    WHEN rolling_avg_acc * 100 >= 60 THEN 'D+'
    ELSE 'D'
  END;

  -- streak: SELECT INTO returns NULL when no matching row; coalesce after.
  SELECT
    uds.current_streak,
    uds.longest_streak,
    uds.total_days_played
  INTO cur_streak, best_streak, total_days
  FROM user_daily_streaks uds
  WHERE uds.user_id = p_user_id;

  cur_streak  := coalesce(cur_streak, 0);
  best_streak := coalesce(best_streak, 0);
  total_days  := coalesce(total_days, 0);

  WITH best_per_mode AS (
    SELECT
      game_mode,
      max(score)            AS best_score,
      max(accuracy)         AS best_accuracy,
      bool_or(perfect_game) AS has_perfect,
      max(created_at)       AS last_played
    FROM memory_leaderboards
    WHERE user_id = p_user_id
    GROUP BY game_mode
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'game_mode',     game_mode,
    'best_score',    best_score,
    'best_accuracy', round(best_accuracy * 100, 1),
    'has_perfect',   has_perfect,
    'last_played',   last_played
  ) ORDER BY best_score DESC), '[]'::jsonb)
  INTO per_mode
  FROM best_per_mode;

  WITH best_per_level AS (
    SELECT
      level,
      max(score)        AS best_score,
      max(accuracy)     AS best_accuracy,
      count(*)          AS attempts,
      max(created_at)   AS last_played
    FROM memory_leaderboards
    WHERE user_id = p_user_id
    GROUP BY level
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'level',         level,
    'best_score',    best_score,
    'best_accuracy', round(best_accuracy * 100, 1),
    'attempts',      attempts,
    'last_played',   last_played,
    'mastered',      best_accuracy >= 0.85
  ) ORDER BY level), '[]'::jsonb)
  INTO per_level
  FROM best_per_level;

  SELECT count(DISTINCT level)
  INTO mastered_count
  FROM memory_leaderboards
  WHERE user_id = p_user_id
    AND accuracy >= 0.85;

  SELECT *
  INTO dc_row
  FROM memory_daily_challenges
  WHERE challenge_date = current_date
  ORDER BY created_at DESC
  LIMIT 1;

  IF dc_row.id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM memory_challenge_completions
      WHERE user_id = p_user_id
        AND challenge_id = dc_row.id
    ) INTO dc_completed;
  END IF;

  result := jsonb_build_object(
    'sessions_this_week',         this_sessions,
    'avg_accuracy_this_week_pct', round(this_avg_acc * 100, 1),
    'diamonds_earned_this_week',  this_diamonds,
    'sessions_last_week',         last_sessions,
    'avg_accuracy_last_week_pct', round(last_avg_acc * 100, 1),
    'rolling_30d_sessions',       rolling_n,
    'rolling_accuracy_pct',       round(rolling_avg_acc * 100, 1),
    'current_grade',              cur_grade,
    'next_grade',                 next_grade,
    'current_streak_days',        cur_streak,
    'longest_streak_days',        best_streak,
    'total_days_played',          total_days,
    'per_mode_best',              per_mode,
    'per_level_mastery',          per_level,
    'mastered_levels_count',      coalesce(mastered_count, 0),
    'daily_challenge',            CASE WHEN dc_row.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id',              dc_row.id,
      'challenge_date',  dc_row.challenge_date,
      'game_mode',       dc_row.game_mode,
      'level',           dc_row.level,
      'scenario_id',     dc_row.scenario_id,
      'target_accuracy', dc_row.target_accuracy,
      'target_time',     dc_row.target_time,
      'diamond_reward',  dc_row.diamond_reward,
      'bonus_reward',    dc_row.bonus_reward
    ) END,
    'daily_challenge_completed',  dc_completed,
    'computed_at',                now()
  );

  RETURN result;
END;
$$;
