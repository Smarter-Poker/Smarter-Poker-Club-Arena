-- 20261008113537_a_running_tournament_that_deals_nothing_is_paged_within_twen.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ============================================================================
-- A RUNNING TOURNAMENT THAT DEALS NOTHING IS PAGED WITHIN TWENTY LIVE MINUTES
-- ============================================================================
--
-- THE BLIND SPOT, measured on production (kuklfnapbkmacvwxktbh) over the
-- seven days to 2026-10-08:
--
--   2026-10-03 23:43Z  16 Spins, Sit & Gos and a satellite lost their
--                      tournament leases under database latency; every
--                      re-admission was refused (f06 custody unproven) and
--                      they sat with 2-3 live players and no hand for 14.4 h.
--   2026-10-06 15:33Z  a foreign psql session in replica mode marked live
--                      players eliminated with no elimination sequence; 55
--                      events went dark for 8.5 to 22.8 h (fixed 20261007132903).
--   2026-10-07 17:38Z  satellite 32190e8c reached its qualifier boundary with
--                      three qualifiers; the cohort receipt refused a settled
--                      pre-start refund ~500 times and the event sat parked
--                      for 17 h (fixed 20261008113442).
--
-- Not one of these raised an alert. fn_ca_tournament_finished_but_not_completed
-- (ca-tournament-finished-not-completed-5m) judges a RUNNING event only once
-- it is down to one player or fewer, and skips satellites outright. An event
-- with two or more live players that simply stops dealing - whatever stopped
-- it - is invisible to every monitor on this database, and in each case above
-- it was found by a person reading the engine log hours later.
--
-- THE DETECTOR
--
-- fn_ca_tournament_dark_while_running(p_minutes) looks at every RUNNING
-- tournament of every type, satellites included, that is not on its own break
-- and is not between days of a multi-day event, has two or more players
-- 'playing'/'active', and whose last sign of life - the newest update on an
-- open table of its own (every dealt hand writes one), its last recorded bust,
-- or its start - is older than the threshold in LIVE engine minutes
-- (fn_ca_engine_live_minutes, so a maintenance break is not counted) or
-- max(3 x threshold, 60) wall-clock minutes whatever the breaks.
--
-- It raises one CRITICAL financial alert per dark tournament (the open alert
-- is keyed on context.tournament_id, so an episode is one incident) and
-- resolves it when the event is COMPLETED or CANCELLED, or when it has dealt
-- again since the alert was raised. Read on production 2026-10-08 11:20Z with
-- a 20-minute threshold against 60 live events: exactly one hit, 32190e8c,
-- 972 live minutes dark; zero false positives among the Spins, Sit & Gos and
-- MTTs dealing at that moment.
--
-- A cron row runs it every five minutes, offset from the other tournament
-- watches (CLAUDE.md: the heavy hourly watches do not start together).
--
-- periodic-work: this schedule is the monitor itself, not compensation for a
-- known failing line. A tournament can stop dealing for a cause nobody has
-- written yet (three unrelated ones in seven days above); the only thing
-- that catches the fourth is a watch that measures the outcome - players
-- seated, no hand - on a clock, exactly as ca-tournament-finished-not-
-- completed-5m does for a decided event. It repairs nothing and moves no
-- money; it raises the page a person acts on.
--
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-tournament-dark-while-running-5m' AND active))

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_dark_open_alert(p_tournament_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT fa.id
    FROM public.financial_alerts fa
   WHERE fa.source = 'fn_ca_tournament_dark_while_running'
     AND NOT fa.resolved
     AND fa.context->>'tournament_id' = p_tournament_id::text
   ORDER BY fa.created_at, fa.id
   LIMIT 1
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
  v_cutoff    interval := make_interval(mins => GREATEST(COALESCE(p_minutes, 20), 1));
  v_wall      interval := GREATEST(make_interval(mins => 3 * GREATEST(COALESCE(p_minutes, 20), 1)), interval '60 minutes');
  v_count     int := 0;
  v_raised    int := 0;
  v_resolved  int := 0;
  v_sample    jsonb := '[]'::jsonb;
BEGIN
  WITH running AS (
    SELECT t.id AS tournament_id,
           t.name,
           t.tournament_type,
           t.variant,
           t.started_at,
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id
               AND tp.status::text IN ('playing', 'active')) AS alive,
           GREATEST(
             t.started_at,
             (SELECT max(tb.updated_at) FROM public.tables tb
               WHERE tb.tournament_id = t.id
                 AND lower(COALESCE(tb.status::text, '')) <> 'closed'),
             (SELECT max(tp.eliminated_at) FROM public.tournament_players tp
               WHERE tp.tournament_id = t.id)) AS last_activity
      FROM public.tournaments t
     WHERE t.status = 'RUNNING'
       AND COALESCE(t.on_break, false) IS NOT TRUE
       AND t.started_at IS NOT NULL
       AND t.started_at < now() - v_cutoff
       AND NOT (COALESCE(t.is_multi_day, false)
                AND COALESCE(t.day_number, 1) < COALESCE(t.total_days, 1))
  ), dark AS (
    SELECT r.*,
           round(extract(epoch FROM (now() - r.last_activity)) / 60.0, 1) AS wall_minutes,
           public.fn_ca_engine_live_minutes(r.last_activity, now()) AS live_minutes
      FROM running r
     WHERE r.alive >= 2
       AND r.last_activity IS NOT NULL
       AND r.last_activity < now() - v_cutoff
  )
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
    FROM dark d
   WHERE d.live_minutes >= v_threshold
      OR d.last_activity < now() - v_wall;

  INSERT INTO public.financial_alerts (severity, source, message, context)
  SELECT 'critical',
         'fn_ca_tournament_dark_while_running',
         format(
           'Tournament %s is RUNNING with %s live players and has dealt nothing for %s '
           || 'minute(s) (%s of them live engine minutes; threshold %s live minutes or %s '
           || 'wall-clock). Its players are seated and waiting; nothing else on this '
           || 'database can see an event with two or more players that has stopped. Read '
           || 'the engine log for this tournament id: a refused settlement, a lost lease '
           || 'whose re-admission is refused, or a parked table nobody is resuming.',
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

  -- A finding that is no longer true closes when it is re-measured: the event
  -- finished, was cancelled, or has dealt since the alert was raised.
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

REVOKE ALL ON FUNCTION public.fn_ca_tournament_dark_while_running(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_dark_open_alert(uuid) FROM PUBLIC, anon, authenticated;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-tournament-dark-while-running-5m') THEN
    PERFORM cron.unschedule('ca-tournament-dark-while-running-5m');
  END IF;
  PERFORM cron.schedule(
    'ca-tournament-dark-while-running-5m',
    '3-59/5 * * * *',
    $$select public.fn_ca_tournament_dark_while_running(20);$$);
END
$cron$;

COMMIT;
