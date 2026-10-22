-- 20261022004756_a_dealing_tournament_is_never_dark.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_ca_tournament_dark_candidates measured a tournament's last activity as the
-- latest write to one of its table rows or the latest bust. Neither moves while
-- hands are dealt between level changes, so an event dealing 20 hands a minute
-- read as dark whenever its level clock was held and nobody busted.
--
-- Turbo Tuesday PKO bc8e3d86, 2026-10-21: its level clock was held for 19 hours
-- by one table that never dealt (fixed in the engine by the same pull request:
-- a stuck table no longer holds the field past ten minutes). Every hour the
-- engine's dark sweep (GameServer, threshold 15 live minutes) read the event as
-- dark while it was dealing, and REBUILT its manager: at 14:07:04 the event had
-- been dealing for six minutes after its 14:00 break, and the rebuild stopped
-- every table until 14:17. Ten rebuilds and ten pages that day, each one a
-- ten-to-twenty-minute stop the watch itself caused.
--
-- A committed hand is the plainest proof a tournament is alive. The latest
-- hand_history row for the event now counts as activity, read from the existing
-- index idx_hand_history_tournament_created (tournament_id, created_at DESC),
-- so it is one index probe per running event. Nothing else changes: same
-- signature, same columns, same thresholds, same callers.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '10s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_tournament_dark_candidates(integer)'::regprocedure))
     <> '905511cdb4d00e6eaded6221e3f85946' THEN
    RAISE EXCEPTION 'DARK_CANDIDATES_PREIMAGE_DRIFT';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_dark_candidates(p_minutes integer DEFAULT 20)
 RETURNS TABLE(tournament_id uuid, name text, tournament_type text, variant text, started_at timestamp with time zone, alive integer, last_activity timestamp with time zone, wall_minutes numeric, live_minutes numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH bounds AS (
    SELECT GREATEST(COALESCE(p_minutes, 20), 1) AS threshold,
           make_interval(mins => GREATEST(COALESCE(p_minutes, 20), 1)) AS cutoff,
           GREATEST(make_interval(mins => 3 * GREATEST(COALESCE(p_minutes, 20), 1)), interval '60 minutes') AS wall
  ), running AS (
    SELECT t.id AS tournament_id,
           t.name::text AS name,
           t.tournament_type::text AS tournament_type,
           t.variant::text AS variant,
           t.started_at,
           (SELECT count(*)::integer FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id
               AND tp.status::text IN ('playing', 'active')) AS alive,
           GREATEST(
             t.started_at,
             (SELECT max(tb.updated_at) FROM public.tables tb
               WHERE tb.tournament_id = t.id
                 AND lower(COALESCE(tb.status::text, '')) <> 'closed'),
             (SELECT max(tp.eliminated_at) FROM public.tournament_players tp
               WHERE tp.tournament_id = t.id),
             -- A DEALT HAND IS ACTIVITY (2026-10-21): an event dealing between
             -- level changes writes no table row and may bust nobody.
             (SELECT hh.created_at FROM public.hand_history hh
               WHERE hh.tournament_id = t.id
               ORDER BY hh.created_at DESC
               LIMIT 1)) AS last_activity
      FROM public.tournaments t, bounds b
     WHERE t.status = 'RUNNING'
       AND (COALESCE(t.on_break, false) IS NOT TRUE
            OR COALESCE(t.break_started_at, t.updated_at) < now() - interval '30 minutes')
       AND t.started_at IS NOT NULL
       AND t.started_at < now() - b.cutoff
       AND NOT (COALESCE(t.is_multi_day, false)
                AND COALESCE(t.day_number, 1) < COALESCE(t.total_days, 1))
  ), dark AS (
    SELECT r.*,
           round(extract(epoch FROM (now() - r.last_activity)) / 60.0, 1) AS wall_minutes,
           public.fn_ca_engine_live_minutes(r.last_activity, now()) AS live_minutes
      FROM running r, bounds b
     WHERE r.alive >= 2
       AND r.last_activity IS NOT NULL
       AND r.last_activity < now() - b.cutoff
  )
  SELECT d.tournament_id, d.name, d.tournament_type, d.variant, d.started_at, d.alive,
         d.last_activity, d.wall_minutes, d.live_minutes
    FROM dark d, bounds b
   WHERE d.live_minutes >= b.threshold
      OR d.last_activity < now() - b.wall
   ORDER BY d.last_activity
$function$;

-- Engine and cron telemetry only (production already holds exactly these
-- grants; stated here so the file says what the database holds).
REVOKE ALL ON FUNCTION public.fn_ca_tournament_dark_candidates(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_dark_candidates(integer) TO service_role;

COMMIT;
