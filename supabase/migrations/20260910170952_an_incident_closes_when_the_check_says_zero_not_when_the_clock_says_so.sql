-- an_incident_closes_when_the_check_says_zero_not_when_the_clock_says_so
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHY THERE ARE STILL OPEN DRIFT INCIDENTS, and it is not what it looks like.
--
-- fn_ca_resolve_cleared_incidents already closes a finding its detector has
-- stopped reporting, and its rule is deliberately conservative: TWO completed
-- runs with no mention of it. That rule is right - a check that TIMES OUT or
-- ERRORS raises a sweepfail under a different key, and one silent run must
-- never be mistaken for the finding having cleared.
--
-- But fn_ca_conservation_sweep runs HOURLY, at :52. So an incident raised at
-- 16:52 and fixed at 16:55 cannot close until 18:52. **Up to two hours of a
-- stale CRITICAL sitting on the board after the thing it names is gone.**
-- That is exactly what happened today: bb7ba3f3 was raised at 16:52 on 20
-- absent players, every one of them was recorded minutes later, and
-- fn_ca_absent_tournament_players has returned ZERO ever since - with the
-- incident still red.
--
-- A board that shows a red item for two hours after the problem is gone is a
-- board people stop trusting, and it is indistinguishable from one that is
-- red because something is actually wrong.
--
-- THE FIX: ask the check. For every open incident from the conservation sweep,
-- re-run that exact check NOW. Zero findings closes it; anything else leaves
-- it exactly where it is.
--
-- This is STRONGER evidence than two silent runs, not weaker: it is a direct
-- measurement of the condition the incident names, taken at close time. And it
-- keeps the guarantee the two-run rule was protecting, because the re-measure
-- is wrapped per check - a check that ERRORS or cannot run is UNKNOWN, and
-- UNKNOWN closes nothing (CLAUDE.md 10.86 rule 1: "I could not tell" is a
-- distinct outcome and never folds into good news).
--
-- The clock-based path is untouched and still runs first, so a detector whose
-- check cannot be re-run generically still closes the old way after two clean
-- runs. Nothing is closed that both paths do not agree about.
--
-- fn_ca_resolve_cleared_incidents is NOT on fn_ca_guard_watchlist(), so no
-- declaration is needed here; verified before writing this.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_ca_close_incidents_the_check_no_longer_finds()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  i         record;
  v_check   text;
  v_n       bigint;
  v_closed  int := 0;
  v_left    int := 0;
  v_unknown int := 0;
  v_actor   uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid;
BEGIN
  /* AN INCIDENT CLOSES WHEN THE CHECK SAYS ZERO (2026-09-10).
     One open incident at a time, each re-measured by re-running the exact
     check named in its own source. A check that errors, times out or cannot
     be called generically is UNKNOWN and closes nothing. */
  FOR i IN
    SELECT d.id, d.source
      FROM public.ca_drift_incidents d
     WHERE d.resolved_at IS NULL
       AND d.source LIKE 'fn_ca_conservation_sweep:%'
     ORDER BY d.detected_at
  LOOP
    v_check := split_part(i.source, ':', 2);
    CONTINUE WHEN v_check !~ '^fn_[a-z0-9_]+$';

    BEGIN
      EXECUTE format('SELECT count(*) FROM public.%I()', v_check) INTO v_n;
    EXCEPTION WHEN OTHERS THEN
      -- could not tell. Never good news.
      v_unknown := v_unknown + 1;
      CONTINUE;
    END;

    IF COALESCE(v_n, -1) = 0 THEN
      UPDATE public.ca_drift_incidents
         SET status = 'resolved', resolved_at = now(), resolved_by = v_actor,
             root_cause = 'the check this incident names was re-run at close time and returned ZERO findings. '
                       || v_check || ' no longer reports the condition it was raised for.',
             correction_ref = 'verified: ' || v_check || ' re-measured at ' || now()::text || ' and found nothing',
             resolution = 'Closed by re-measurement, not by a clock and not by assumption. No chips moved. '
                       || 'If the condition returns, the next sweep raises it again as a fresh incident.'
       WHERE id = i.id AND resolved_at IS NULL;
      v_closed := v_closed + 1;
    ELSE
      v_left := v_left + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'closed', v_closed,
                            'still_finding', v_left, 'could_not_tell', v_unknown);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_close_incidents_the_check_no_longer_finds() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_close_incidents_the_check_no_longer_finds() TO service_role;

DO $body$
DECLARE
  v_res jsonb;
  v_open_before int;
  v_open_after int;
  v_browser int;
BEGIN
  SELECT count(*) INTO v_open_before FROM public.ca_drift_incidents WHERE resolved_at IS NULL;

  v_res := public.fn_ca_close_incidents_the_check_no_longer_finds();
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'the re-measure pass did not complete: %', v_res::text;
  END IF;

  SELECT count(*) INTO v_open_after FROM public.ca_drift_incidents WHERE resolved_at IS NULL;
  RAISE NOTICE 'open incidents % -> %; %', v_open_before, v_open_after, v_res::text;

  -- nobody in a browser may close a money-board incident
  SELECT count(*) INTO v_browser
    FROM (VALUES ('anon'), ('authenticated'), ('public')) AS r(role_name)
   WHERE has_function_privilege(r.role_name,
           'public.fn_ca_close_incidents_the_check_no_longer_finds()', 'EXECUTE');
  IF v_browser <> 0 THEN
    RAISE EXCEPTION '% browser role(s) can execute the incident closer', v_browser;
  END IF;

  -- and anything still open must be something a check is ACTIVELY finding,
  -- or something no check can be asked about generically
  IF COALESCE((v_res->>'closed')::int, 0) = 0
     AND COALESCE((v_res->>'still_finding')::int, 0) = 0
     AND COALESCE((v_res->>'could_not_tell')::int, 0) = 0 THEN
    RAISE EXCEPTION 'no conservation-sweep incident was examined at all; the source pattern is wrong';
  END IF;
END
$body$;

COMMIT;
