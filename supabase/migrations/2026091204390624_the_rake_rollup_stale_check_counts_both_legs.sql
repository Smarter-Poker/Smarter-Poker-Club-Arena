-- The rake rollup stale check counts both legs, and the writer stops running
-- under an eight second HTTP budget.
--
-- Drift incident ba809d65-b77a-4e09-881b-6d617489ad23,
-- union_rake_rollup_unmaintained: "Unions with 3+ missing rake rollup days in
-- the last week". It is real, and it is worse than the alert says. Two
-- independent defects, neither of them in the checker.
--
-- DEFECT A - the writer is cancelled on every single run. The only scheduled
-- caller of fn_union_rake_rollup_catchup_all is the engine
-- (RakebackSettlerService.runUnionRakeRollupCatchup), which POSTs it over
-- PostgREST as service_role. service_role carries statement_timeout=8s. Union
-- rake volume has roughly tripled since August (2026-09-08 alone: 69,404
-- records), so one day's player_contributions expansion no longer fits in
-- eight seconds. Measured: 33 calls in 24 hours, 33 HTTP 500s, zero successes,
-- each edge/postgrest pair exactly 8s apart, SQLSTATE 57014 "canceling
-- statement due to statement timeout" on the INSERT INTO
-- union_rake_paid_daily_user. The cancel escapes the per-day exception handler,
-- so the whole transaction rolls back and NO rollup row is written at all. The
-- function does not even appear in pg_stat_statements - a cancelled statement
-- never reaches ExecutorEnd - which is exactly why this looked like a job that
-- was never wired up rather than one dying in plain sight.
--
-- DEFECT B - two disagreeing definitions of "stale". fn_union_rake_rollup_-
-- refresh_day writes records_seen = cash leg + tournament leg, and
-- fn_union_rake_day_is_fresh checks it against both legs. But this function
-- counted the CASH leg only, so every day that carried tournament rake was
-- reported stale forever. 2026-09-08 is the proof: records_seen 69,404 = cash
-- 59,719 + tournament 9,685, day_is_fresh says TRUE, and stale_days listed it
-- anyway. Days are returned oldest-first and the catch-up takes the first
-- p_max_days (3), so the budget was spent re-rolling 09-08 (already correct,
-- and the largest day on the board) plus 09-09 and 09-10 - and 2026-09-11 was
-- unreachable by construction, every cycle, forever.
--
-- Together: the writer could not finish a day, and the list of days to write
-- was wrong. Last rollup row written anywhere: 2026-09-09 10:10:34. Sixty-eight
-- hours of silence that nothing on the platform remarked on, because
-- fn_ca_cron_failure_watch reads cron.job_run_details and this writer was an
-- engine task - so no failure row existed anywhere in the database and the
-- absence of an error was read as success.
--
-- WHAT IT COST. No chips are mispaid: the settlement rounds pay on
-- fn_union_club_rake_basis -> ca_union_rake_attribution, which is fully current
-- and attributed hourly by pg_cron job 254. Not one of the weekly settlement
-- functions reads union_rake_paid_daily_user. But three of its five consumers -
-- fn_agent_player_breakdown, ca_club_player_page and ca_club_player_breakdown -
-- read the rollup raw, with no freshness test and no live fallback. So
-- 286,027.79 chips of union rake for 09-09, 09-10 and 09-11 are currently
-- invisible to every agent's player breakdown and to the Club Data player page,
-- and agents see their rakeback entitlement understated for the three biggest
-- days of the current week.
--
-- The detail string on the invariant is also out of date and is corrected
-- elsewhere: "the weekly settlement would recompute them while holding treasury
-- locks" stopped being true when the rake basis moved to
-- ca_union_rake_attribution on 2026-09-07 and the cascade started warming the
-- cache before its first lock on 2026-09-09. The true cost today is wrong
-- numbers on agent and club screens, which is worse than a slow lock.
--
-- The job goes on pg_cron alongside its two siblings, club-rake-rollup-catchup
-- (jobid 128) and bbj-rollup-catchup (jobid 134), which are the same kind of
-- work and already live there. It runs as postgres, which carries no eight
-- second ceiling, and takes the advisory lock + explicit statement_timeout
-- shape this database already uses for its heavier jobs. This is NOT the Claude
-- scheduler that section 10.85 forbids; it is a real cron, and an Open Claw
-- HTTP handler would land straight back on the same PostgREST budget that
-- caused the outage.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_union_rake_stale_days(p_union_id uuid, p_from date, p_to_exclusive date)
 RETURNS SETOF date
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
  /* BOTH LEGS, because records_seen is written from both. The cash-only count
     here made every day that carried tournament rake permanently stale, which
     wasted the catch-up budget on correct days and starved the newest one. The
     predicate below is character-for-character the one in
     fn_union_rake_day_is_fresh - if these two ever disagree again, the catch-up
     chases days the freshness test already considers done. */
  WITH legs AS (
    SELECT (r.created_at AT TIME ZONE 'UTC')::date AS day
      FROM rake_records r
      JOIN tables t ON t.id = r.table_id AND t.union_id = p_union_id
     WHERE r.created_at >= (p_from::timestamp AT TIME ZONE 'UTC')
       AND r.created_at <  (p_to_exclusive::timestamp AT TIME ZONE 'UTC')
       AND r.player_contributions IS NOT NULL AND r.rake_amount > 0
    UNION ALL
    SELECT (r.created_at AT TIME ZONE 'UTC')::date
      FROM rake_records r
     WHERE r.is_tournament
       AND r.created_at >= (p_from::timestamp AT TIME ZONE 'UTC')
       AND r.created_at <  (p_to_exclusive::timestamp AT TIME ZONE 'UTC')
       AND r.rake_amount <> 0
       AND (r.club_id = p_union_id
            OR EXISTS (SELECT 1 FROM union_clubs uc
                        WHERE uc.union_id = p_union_id AND uc.club_id = r.club_id))
  ),
  live AS (SELECT legs.day AS day, count(*) AS n FROM legs GROUP BY 1),
  days AS (
    SELECT gs::date AS day
      FROM generate_series(p_from, p_to_exclusive - 1, interval '1 day') gs
  )
  SELECT d.day
    FROM days d
    LEFT JOIN live l ON l.day = d.day
    LEFT JOIN union_rake_rollup_days u
      ON u.union_id = p_union_id AND u.day = d.day
   WHERE u.day IS NULL
      OR u.records_seen IS DISTINCT FROM COALESCE(l.n, 0)
   ORDER BY d.day;
$function$;

SELECT cron.unschedule('union-rake-rollup-catchup')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'union-rake-rollup-catchup');

SELECT cron.schedule('union-rake-rollup-catchup', '55 * * * *', $job$
DO $body$
BEGIN
  IF pg_try_advisory_lock(hashtext('union-rake-rollup-catchup')) THEN
    PERFORM set_config('statement_timeout', '600s', true);
    PERFORM public.fn_union_rake_rollup_catchup_all(8);
  ELSE
    RAISE NOTICE 'skipped: union-rake-rollup-catchup already running';
  END IF;
END
$body$;
$job$);

COMMIT;
