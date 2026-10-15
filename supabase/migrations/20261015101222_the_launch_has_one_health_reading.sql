-- @live-proof: to_regprocedure('public.fn_ca_launch_health()') IS NOT NULL AND NOT has_function_privilege('authenticated','public.fn_ca_launch_health()','EXECUTE') AND NOT has_function_privilege('anon','public.fn_ca_launch_health()','EXECUTE') AND has_function_privilege('service_role','public.fn_ca_launch_health()','EXECUTE')
-- 20261015101222_the_launch_has_one_health_reading.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS ADDS, AND WHY:
--
-- Launch readiness was a dozen separate readings (financial_alerts, the
-- settlement health view, the weekly close runs, the cron board, tournament
-- liveness), and nobody could answer "is the platform ready right now" in
-- one call. fn_ca_launch_health() is that one call. It returns one row per
-- area, green / amber / red, with the detail behind the colour, and a final
-- 'launch' row that is the worst of them:
--
--   financial_alerts  red on any unresolved critical, amber on any warning
--   hand_settlement   red on any failed or stuck hand in the last hour
--   weekly_close      red on a close still open 48 hours after its week
--                     ended, amber while one is in progress; a week the
--                     owner moved below a settlement floor (20260920232523)
--                     is preserved history, not an open close
--   tournaments       red on a running event that has dealt no hand for 15
--                     minutes off a break, or one still registering 15
--                     minutes after its start (green during the platform
--                     freeze, when nothing deals by design)
--   scheduled_jobs    red on a critical cron verdict, amber on a warning
--
-- A reading that throws is 'unknown' and counts as red: a reading that could
-- not be taken is not a green one (CLAUDE.md 10.86 rule 1).
--
-- It is a pure read. Every function it calls was checked to write nothing:
-- fn_settlement_health and fn_ca_cron_health are STABLE with no INSERT,
-- UPDATE or PERFORM; fn_platform_frozen reads one row. It deliberately does
-- NOT call fn_money_check_health, which files a financial alert for every
-- stale heartbeat as a side effect.
--
-- Measured on production 2026-10-15 with a pg_temp copy: under one second.
-- Service role only.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

DO $guard$
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres'
     OR NULLIF(current_setting('request.jwt.claims', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'launch_health_operator_refused' USING ERRCODE = '42501';
  END IF;
  IF to_regprocedure('public.fn_ca_launch_health()') IS NOT NULL THEN
    RAISE EXCEPTION 'launch_health_exists';
  END IF;
  IF to_regprocedure('public.fn_settlement_health(integer)') IS NULL
     OR to_regprocedure('public.fn_ca_cron_health(interval)') IS NULL
     OR to_regprocedure('public.fn_platform_frozen()') IS NULL
     OR to_regclass('public.union_settlement_floor') IS NULL
     OR to_regclass('public.club_settlement_floor') IS NULL THEN
    RAISE EXCEPTION 'launch_health_dependency_missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid IN ('public.fn_settlement_health(integer)'::regprocedure,
                              'public.fn_ca_cron_health(interval)'::regprocedure)
                AND (p.provolatile <> 's' OR p.prosrc ~* '\m(insert|update|delete|perform)\M')) THEN
    RAISE EXCEPTION 'launch_health_dependency_writes';
  END IF;
END
$guard$;

CREATE FUNCTION public.fn_ca_launch_health()
 RETURNS TABLE(area text, status text, detail jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v jsonb;
  v_status text;
  v_worst int := 0;
  v_rank constant jsonb := '{"green":0,"amber":1,"red":2,"unknown":2}';
  n_crit bigint; n_warn bigint; n_fail bigint; n_stuck bigint;
BEGIN
  -- 1. Open financial alerts. Every unresolved critical is red: it is either
  -- a live defect or an alert nobody has closed, and both block launch.
  SELECT count(*) FILTER (WHERE f.severity = 'critical'),
         count(*) FILTER (WHERE f.severity IS DISTINCT FROM 'critical')
    INTO n_crit, n_warn
    FROM public.financial_alerts f
   WHERE f.resolved IS NOT TRUE;
  SELECT COALESCE(jsonb_object_agg(x.source || ':' || x.severity, x.n), '{}'::jsonb) INTO v
    FROM (SELECT f.source, f.severity, count(*) AS n FROM public.financial_alerts f
           WHERE f.resolved IS NOT TRUE GROUP BY 1, 2) x;
  v_status := CASE WHEN n_crit > 0 THEN 'red' WHEN n_warn > 0 THEN 'amber' ELSE 'green' END;
  area := 'financial_alerts'; status := v_status;
  detail := jsonb_build_object('critical', n_crit, 'warning', n_warn, 'by_source', v);
  v_worst := GREATEST(v_worst, (v_rank->>status)::int); RETURN NEXT;

  -- 2. Hand settlement over the last hour.
  BEGIN
    SELECT s.failed, s.stuck, to_jsonb(s) INTO n_fail, n_stuck, v FROM public.fn_settlement_health(60) s;
    status := CASE WHEN n_fail > 0 OR n_stuck > 0 THEN 'red' ELSE 'green' END;
  EXCEPTION WHEN OTHERS THEN
    status := 'unknown'; v := jsonb_build_object('error', SQLERRM);
  END;
  area := 'hand_settlement'; detail := v;
  v_worst := GREATEST(v_worst, (v_rank->>status)::int); RETURN NEXT;

  -- 3. Weekly accounting closes. A scope still open more than 48 hours after
  -- its week ended is red; a close in progress inside that is amber.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('scope_kind', r.scope_kind, 'scope_id', r.scope_id,
           'period_end', r.period_end, 'status', r.status, 'attempts', r.attempts,
           'last_visit', r.last_scheduler_visit_at) ORDER BY r.period_end), '[]'::jsonb),
         CASE WHEN bool_or(now() > r.period_end + interval '48 hours') THEN 'red'
              WHEN count(*) > 0 THEN 'amber' ELSE 'green' END
    INTO v, status
    FROM public.union_accounting_runs r
   WHERE r.status IS DISTINCT FROM 'complete'
     -- A week the owner moved below a settlement floor (20260920232523) is
     -- preserved history with its obligations recorded, not an open close.
     AND NOT EXISTS (SELECT 1 FROM public.union_settlement_floor u
                      WHERE r.scope_kind = 'union' AND u.union_id = r.scope_id
                        AND r.period_start < u.earliest_period_start)
     AND NOT EXISTS (SELECT 1 FROM public.club_settlement_floor c
                      WHERE r.scope_kind = 'club' AND c.club_id = r.scope_id
                        AND r.period_start < c.earliest_period_start);
  area := 'weekly_close'; detail := jsonb_build_object('open_scopes', v);
  v_worst := GREATEST(v_worst, (v_rank->>status)::int); RETURN NEXT;

  -- 4. Tournaments: a running event that has dealt no hand for 15 minutes
  -- while not on a break, or an event still registering 15 minutes after its
  -- start, is red.
  SELECT jsonb_build_object(
           'running_silent', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name))
              FROM public.tournaments t
             WHERE t.status = 'RUNNING' AND NOT COALESCE(t.on_break, false)
               AND t.started_at < now() - interval '15 minutes'
               AND NOT EXISTS (SELECT 1 FROM public.hand_history h
                                WHERE h.tournament_id = t.id
                                  AND h.created_at > now() - interval '15 minutes')), '[]'::jsonb),
           'start_overdue', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'start_time', t.start_time))
              FROM public.tournaments t
             WHERE t.status = 'REGISTERING' AND t.start_time < now() - interval '15 minutes'), '[]'::jsonb))
    INTO v;
  status := CASE WHEN jsonb_array_length(v->'running_silent') > 0
                   OR jsonb_array_length(v->'start_overdue') > 0 THEN 'red' ELSE 'green' END;
  IF COALESCE(public.fn_platform_frozen(), false) THEN
    status := 'green'; v := v || jsonb_build_object('note', 'platform frozen for the maintenance break');
  END IF;
  area := 'tournaments'; detail := v;
  v_worst := GREATEST(v_worst, (v_rank->>status)::int); RETURN NEXT;

  -- 5. Scheduled jobs over the last 24 hours.
  BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('job', c.jobname, 'verdict', c.verdict,
             'last_error', left(c.last_error, 200)) ORDER BY c.jobname)
             FILTER (WHERE c.verdict IN ('critical', 'warn')), '[]'::jsonb),
           CASE WHEN bool_or(c.verdict = 'critical') THEN 'red'
                WHEN bool_or(c.verdict = 'warn') THEN 'amber' ELSE 'green' END
      INTO v, status
      FROM public.fn_ca_cron_health(interval '24 hours') c;
  EXCEPTION WHEN OTHERS THEN
    status := 'unknown'; v := jsonb_build_object('error', SQLERRM);
  END;
  area := 'scheduled_jobs'; detail := jsonb_build_object('not_ok', v);
  v_worst := GREATEST(v_worst, (v_rank->>status)::int); RETURN NEXT;

  -- 6. Overall: the worst of the above. "unknown" counts as red, because a
  -- reading that could not be taken is not a green one.
  area := 'launch';
  status := CASE v_worst WHEN 0 THEN 'green' WHEN 1 THEN 'amber' ELSE 'red' END;
  detail := jsonb_build_object('checked_at', now());
  RETURN NEXT;
END
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_launch_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_launch_health() TO service_role;
COMMENT ON FUNCTION public.fn_ca_launch_health() IS
 'One launch readiness reading: one row per area (green, amber, red) and a final launch row that is the worst of them. Pure read (20261015101222).';

COMMIT;
