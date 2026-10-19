-- 20261019223841_measure_late_mtt_launches_from_the_first_dealt_hand.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A late tournament start was invisible. tournaments.started_at is written
-- equal to start_time (166 of 166 MTTs in the 24 h to 2026-10-19 22:00 UTC),
-- so no rule reading started_at can ever see a late launch, and
-- TournamentNeverStarted only fires on an MTT still REGISTERING ten minutes
-- after its start. Measured from the first dealt hand instead
-- (hand_history.started_at of the event's earliest recorded hands), from
-- 2026-10-12 to 2026-10-18 20-30% of scheduled MTTs dealt their first hand
-- more than 60 s after start_time and 9-14% more than 120 s; the worst was
-- 7,648 s. By minute of the hour, every MTT scheduled :53-:57 started late
-- (held through the hourly break), and :00 starts had a median lateness of
-- 85 s with 59 of 212 over 120 s.
--
-- started_at keeps its meaning: other code reads it (break and progress
-- clocks, lobby), and this change does not touch it. This adds one read-only
-- STABLE function the engine's TournamentMetrics reads once a minute, so the
-- measurement comes from the hands themselves:
--
--   late_first_hands  MTTs whose first recorded hand was dealt more than
--                     p_late_seconds after start_time, recorded within the
--                     last p_window_minutes;
--   late_waiting      MTTs still ANNOUNCED/REGISTERING/RUNNING with no
--                     recorded hand p_late_seconds + p_headroom_seconds after
--                     start_time. hand_history is written when a hand ENDS
--                     (created_at - started_at p99 77 s over the 30 min to
--                     22:40 UTC), so the headroom keeps an on-time first hand
--                     that is still in play from reading as late;
--   worst_late_seconds the largest lateness among the two, 0 when none.
--
-- Measured as a plain query on production 2026-10-19 22:45 UTC: 111 ms, one
-- index range on idx_tournaments_start_time (165 MTTs in 24 h) and a 20-row
-- index probe per MTT on idx_hand_history_tournament_created. No table, no
-- foreign key, no lock beyond the function definition itself. Grants mirror
-- fn_tournament_progress_metrics exactly (postgres, service_role).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.fn_tournament_launch_lateness_metrics(
  p_late_seconds integer DEFAULT 120,
  p_headroom_seconds integer DEFAULT 120,
  p_window_minutes integer DEFAULT 15,
  p_lookback_hours integer DEFAULT 24
)
 RETURNS TABLE(late_first_hands integer, late_waiting integer, worst_late_seconds integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH b AS (
    SELECT statement_timestamp() AS now_at,
           make_interval(secs => LEAST(86400, GREATEST(1, COALESCE(p_late_seconds, 120)))) AS late,
           make_interval(secs => LEAST(3600, GREATEST(0, COALESCE(p_headroom_seconds, 120)))) AS headroom,
           make_interval(mins => LEAST(1440, GREATEST(1, COALESCE(p_window_minutes, 15)))) AS win,
           make_interval(hours => LEAST(168, GREATEST(1, COALESCE(p_lookback_hours, 24)))) AS lookback
  ),
  c AS (
    SELECT t.start_time, t.status, f.first_created, f.first_started
      FROM public.tournaments t
     CROSS JOIN b
      LEFT JOIN LATERAL (
        -- The event's earliest recorded hands; the earliest deal among them is
        -- its first hand. Rows are written at hand end, so take a few.
        SELECT min(x.created_at) AS first_created, min(x.started_at) AS first_started
          FROM (SELECT h.created_at, h.started_at
                  FROM public.hand_history h
                 WHERE h.tournament_id = t.id
                 ORDER BY h.created_at ASC
                 LIMIT 20) x
      ) f ON true
     WHERE t.start_time > b.now_at - b.lookback
       AND t.start_time < b.now_at - b.late
       AND t.format_contract IN ('mtt-v1','mtt-v2')
       AND t.status <> 'CANCELLED'
  ),
  m AS (
    SELECT
      c.first_created IS NOT NULL
        AND c.first_created > b.now_at - b.win
        AND c.first_started > c.start_time + b.late AS late_dealt,
      c.first_created IS NULL
        AND c.status IN ('ANNOUNCED','REGISTERING','RUNNING')
        AND c.start_time < b.now_at - b.late - b.headroom AS late_waiting,
      CASE WHEN c.first_created IS NULL THEN b.now_at - c.start_time
           ELSE c.first_started - c.start_time END AS lateness
      FROM c CROSS JOIN b
  )
  SELECT count(*) FILTER (WHERE m.late_dealt)::integer,
         count(*) FILTER (WHERE m.late_waiting)::integer,
         COALESCE(max(extract(epoch FROM m.lateness))
                    FILTER (WHERE m.late_dealt OR m.late_waiting), 0)::integer
    FROM m;
$function$;

COMMENT ON FUNCTION public.fn_tournament_launch_lateness_metrics(integer, integer, integer, integer) IS
  'Read-only launch-lateness gauges for TournamentMetrics: MTTs whose first dealt hand (hand_history.started_at) came over p_late_seconds after start_time, recorded in the last p_window_minutes, and MTTs with no recorded hand p_late_seconds + p_headroom_seconds after start_time. tournaments.started_at equals start_time and cannot show lateness. 2026-10-19.';

REVOKE ALL ON FUNCTION public.fn_tournament_launch_lateness_metrics(integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_launch_lateness_metrics(integer, integer, integer, integer) TO service_role;

COMMIT;
