-- 20261008140537_the_dark_tournament_watch_answers_the_engine_too.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ============================================================================
-- THE DARK TOURNAMENT WATCH ANSWERS THE ENGINE TOO
-- ============================================================================
--
-- 20261008113537 made fn_ca_tournament_dark_while_running page a RUNNING
-- event with two or more live players that has dealt nothing for twenty live
-- minutes. A page is for a person. The engine can act on the same reading
-- itself: GameServer's discovery loop retires the exact manager that holds a
-- dark event so the RUNNING resume lane re-admits it from durable state, the
-- same mechanism the never-dealt sweep has used since 2026-08-24 for an event
-- that never dealt at all. That cures every in-memory wedge (a pause claim
-- nobody lowers, a sweep cursor that never advances, a lease proof that
-- cannot renew) without a person and without a restart.
--
-- fn_ca_tournament_dark_candidates(p_minutes) is the read the page is built
-- from, extracted so the engine and the cron share one definition of "dark":
-- it raises nothing and writes nothing. fn_ca_tournament_dark_while_running
-- now reads it and keeps its alert, resolve and cron behaviour exactly.
--
-- @live-proof: (SELECT to_regprocedure('public.fn_ca_tournament_dark_candidates(integer)') IS NOT NULL)

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_dark_candidates(p_minutes integer DEFAULT 20)
RETURNS TABLE (
  tournament_id uuid,
  name text,
  tournament_type text,
  variant text,
  started_at timestamptz,
  alive integer,
  last_activity timestamptz,
  wall_minutes numeric,
  live_minutes numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
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
               WHERE tp.tournament_id = t.id)) AS last_activity
      FROM public.tournaments t, bounds b
     WHERE t.status = 'RUNNING'
       AND COALESCE(t.on_break, false) IS NOT TRUE
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

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_dark_while_running(p_minutes integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_threshold integer := GREATEST(COALESCE(p_minutes, 20), 1);
  v_wall      interval := GREATEST(make_interval(mins => 3 * GREATEST(COALESCE(p_minutes, 20), 1)), interval '60 minutes');
  v_count     int := 0;
  v_raised    int := 0;
  v_resolved  int := 0;
  v_sample    jsonb := '[]'::jsonb;
BEGIN
  SELECT count(*),
         COALESCE(jsonb_agg(jsonb_build_object(
           'tournament_id', d.tournament_id,
           'name', left(COALESCE(d.name, ''), 60),
           'tournament_type', d.tournament_type,
           'variant', d.variant,
           'alive', d.alive,
           'last_activity', d.last_activity,
           'wall_minutes', d.wall_minutes,
           'live_minutes', d.live_minutes) ORDER BY d.last_activity), '[]'::jsonb)
    INTO v_count, v_sample
    FROM public.fn_ca_tournament_dark_candidates(v_threshold) d;

  INSERT INTO public.financial_alerts (severity, source, message, context)
  SELECT 'critical',
         'fn_ca_tournament_dark_while_running',
         format(
           'Tournament %s is RUNNING with %s live players and has dealt nothing for %s '
           || 'minute(s) (%s of them live engine minutes; threshold %s live minutes or %s '
           || 'wall-clock). Its players are seated and waiting; nothing else on this '
           || 'database can see an event with two or more players that has stopped. The '
           || 'engine rebuilds the manager of a dark event on its own (GameServer dark '
           || 'sweep); a page means that did not cure it. Read the engine log for this '
           || 'tournament id: a refused settlement, a lost lease whose re-admission is '
           || 'refused, or a parked table nobody is resuming.',
           s->>'tournament_id', s->>'alive', s->>'wall_minutes', s->>'live_minutes',
           v_threshold, v_wall),
         jsonb_build_object(
           'checked_at', now(),
           'threshold_minutes', v_threshold,
           'tournament_id', s->>'tournament_id',
           'tournament', s)
    FROM jsonb_array_elements(v_sample) s
   WHERE public.fn_ca_tournament_dark_open_alert((s->>'tournament_id')::uuid) IS NULL;
  GET DIAGNOSTICS v_raised = ROW_COUNT;

  WITH named AS (
    SELECT fa.id AS alert_id, fa.created_at AS raised_at, t.id AS tournament_id, t.status,
           GREATEST(
             (SELECT max(tb.updated_at) FROM public.tables tb WHERE tb.tournament_id = t.id),
             (SELECT max(tp.eliminated_at) FROM public.tournament_players tp WHERE tp.tournament_id = t.id)) AS last_activity
      FROM public.financial_alerts fa
      LEFT JOIN public.tournaments t
        ON t.id = CASE
                    WHEN (fa.context->>'tournament_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN (fa.context->>'tournament_id')::uuid
                  END
     WHERE fa.source = 'fn_ca_tournament_dark_while_running'
       AND NOT fa.resolved
  )
  UPDATE public.financial_alerts fa
     SET resolved = true,
         resolved_at = now(),
         resolution = format(
           'Re-measured by fn_ca_tournament_dark_while_running at %s: tournament %s is %s '
           || 'and its last activity is %s, after the alert was raised at %s.',
           now(), n.tournament_id, n.status, n.last_activity, n.raised_at)
    FROM named n
   WHERE fa.id = n.alert_id
     AND NOT fa.resolved
     AND (n.status IN ('COMPLETED', 'CANCELLED', 'CANCELED')
          OR (n.status = 'RUNNING' AND n.last_activity > n.raised_at));
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'checked_at', now(),
    'threshold_minutes', v_threshold,
    'dark', v_count,
    'raised', v_raised,
    'resolved', v_resolved,
    'tournaments', v_sample);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_dark_candidates(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_dark_candidates(integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_dark_while_running(integer) FROM PUBLIC, anon, authenticated;

COMMIT;
