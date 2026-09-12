-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260912044823; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260912044823   (the stamp IS the apply time, UTC: 2026-09-12 04:48:23)
--   name        the_rake_rollup_stale_check_counts_both_legs
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 2673 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260912044823 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_union_rake_stale_days

--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_union_rake_stale_days(p_union_id uuid, p_from date, p_to_exclusive date)
 RETURNS SETOF date
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
  /* BOTH LEGS, because records_seen is written from both (2026-09-12, drift
     incident ba809d65). The cash-only count here made every day that carried
     tournament rake permanently stale, which wasted the catch-up budget on
     already-correct days and starved the newest one forever. 2026-09-08:
     records_seen 69,404 = cash 59,719 + tournament 9,685, day_is_fresh TRUE,
     and this function listed it anyway. The predicate below is the one in
     fn_union_rake_day_is_fresh - if these two disagree again, the catch-up
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
