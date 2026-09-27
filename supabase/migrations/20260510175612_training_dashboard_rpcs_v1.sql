-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260510175612 "training_dashboard_rpcs_v1"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f2879c995d47564e4e78d01b68522fcf of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- training_dashboard_rpcs_v1 — TRAIN-DB-DASHBOARD-1
-- ═══════════════════════════════════════════════════════════════════════════
-- The May 8 training-overhaul handoff referenced training_dashboard_*
-- RPCs as if they had been applied via migration 20260507120000_training_
-- dashboard_rpcs.sql, but a SELECT against pg_proc on 2026-05-10 confirmed
-- that NO `training_*` functions existed. This migration creates them so
-- the deferred Session Setup popup (issue #288) and any future training
-- dashboard surface can pull real per-user×game stats with a single
-- round-trip instead of four ad-hoc REST queries.
--
-- Authorization: each RPC is SECURITY DEFINER but checks `auth.uid() =
-- p_user_id` at the top so callers can only see their own stats. EXECUTE
-- is granted to `authenticated` only — anon users cannot call these.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. 30-day rolling stats per user×game
CREATE OR REPLACE FUNCTION public.training_dashboard_30day_stats(
  p_user_id uuid,
  p_game_id text
)
RETURNS TABLE (
  avg_score      numeric,
  sessions_count bigint,
  hands_played   bigint,
  best_score     numeric,
  total_ev_loss  numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'unauthorized: can only query your own stats'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT
    round(avg(s.gtow_score)::numeric, 2)            AS avg_score,
    count(*)::bigint                                AS sessions_count,
    coalesce(sum(s.hands_played), 0)::bigint        AS hands_played,
    round(max(s.gtow_score)::numeric, 2)            AS best_score,
    round(coalesce(sum(s.total_ev_loss), 0), 2)     AS total_ev_loss
  FROM public.training_sessions s
  WHERE s.user_id = p_user_id
    AND s.game_id = p_game_id
    AND s.created_at >= now() - interval '30 days';
END;
$$;

-- 2. Most recent session for a user×game (the "Last session" recap row)
CREATE OR REPLACE FUNCTION public.training_dashboard_last_session(
  p_user_id uuid,
  p_game_id text
)
RETURNS TABLE (
  session_id   uuid,
  gtow_score   numeric,
  accuracy     numeric,
  hands_played integer,
  level        integer,
  level_passed boolean,
  created_at   timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'unauthorized: can only query your own stats'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT
    s.id,
    s.gtow_score,
    s.accuracy,
    s.hands_played,
    s.level,
    s.level_passed,
    s.created_at
  FROM public.training_sessions s
  WHERE s.user_id = p_user_id
    AND s.game_id = p_game_id
  ORDER BY s.created_at DESC
  LIMIT 1;
END;
$$;

-- 3. Lifetime stats per user×game (best, average, highest level passed)
CREATE OR REPLACE FUNCTION public.training_dashboard_lifetime_stats(
  p_user_id uuid,
  p_game_id text
)
RETURNS TABLE (
  total_sessions       bigint,
  total_hands          bigint,
  best_score           numeric,
  avg_score            numeric,
  highest_level_passed integer,
  total_diamonds_est   bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'unauthorized: can only query your own stats'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT
    count(*)::bigint                                                                  AS total_sessions,
    coalesce(sum(s.hands_played), 0)::bigint                                          AS total_hands,
    round(max(s.gtow_score)::numeric, 2)                                              AS best_score,
    round(avg(s.gtow_score)::numeric, 2)                                              AS avg_score,
    coalesce(max(s.level) FILTER (WHERE s.level_passed), 0)::integer                  AS highest_level_passed,
    coalesce(sum((s.classification_counts->>'best')::bigint
               + (s.classification_counts->>'correct')::bigint) FILTER (
        WHERE s.classification_counts ? 'best' AND s.classification_counts ? 'correct'
      ), 0)::bigint                                                                   AS total_diamonds_est
  FROM public.training_sessions s
  WHERE s.user_id = p_user_id
    AND s.game_id = p_game_id;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────
-- Permissions: authenticated users only. Anonymous users cannot read
-- per-user dashboard data. Each function's auth.uid() check enforces
-- per-user isolation regardless.
-- ───────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.training_dashboard_30day_stats(uuid, text)    FROM PUBLIC;
REVOKE ALL ON FUNCTION public.training_dashboard_last_session(uuid, text)   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.training_dashboard_lifetime_stats(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.training_dashboard_30day_stats(uuid, text)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.training_dashboard_last_session(uuid, text)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.training_dashboard_lifetime_stats(uuid, text) TO authenticated;

-- ───────────────────────────────────────────────────────────────────────
-- Comments — searchable in pg_description and discoverable via pg_proc.
-- ───────────────────────────────────────────────────────────────────────
COMMENT ON FUNCTION public.training_dashboard_30day_stats(uuid, text) IS
  'TRAIN-DB-DASHBOARD-1: Returns 30-day rolling avg_score / sessions_count / hands_played / best_score / total_ev_loss for the calling user on the given game_id. SECURITY DEFINER + auth.uid() check.';

COMMENT ON FUNCTION public.training_dashboard_last_session(uuid, text) IS
  'TRAIN-DB-DASHBOARD-1: Returns the most recent training_sessions row for the calling user on the given game_id (or empty if none). SECURITY DEFINER + auth.uid() check.';

COMMENT ON FUNCTION public.training_dashboard_lifetime_stats(uuid, text) IS
  'TRAIN-DB-DASHBOARD-1: Returns total_sessions / total_hands / best_score / avg_score / highest_level_passed for the calling user on the given game_id. SECURITY DEFINER + auth.uid() check.';

