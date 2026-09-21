-- BACKFILLED 2026-09-21 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260914011009; the .sql file was never committed at the
-- time (rake-rollup deadline hardening; found by the two-way migration diff of
-- 2026-09-21). Content is byte-exact to what ran. Do NOT re-apply; it is already
-- live.
--
-- VERIFIED LIVE 2026-09-21 07:06:55 UTC, by the postflight this migration asserts
-- for itself: md5(pg_get_functiondef('public.fn_ca_rake_rollup_writer_silent(integer)'))
-- = 9c5c569556467e0bb71d4a0d6fe33990, owner postgres, SECURITY DEFINER,
-- proconfig {search_path=public}, proacl {postgres=X/postgres,service_role=X/postgres}.
-- All four read back exactly as written.
--
-- WHAT IT DOES. The first daily rake rollup cannot be overdue before its own
-- scheduled start plus its configured execution budget, so the silence monitor
-- stopped calling a rollup that has not been due yet a missed one. Older missing
-- days and the silence check itself are kept.
--
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_rake_rollup_writer_silent(integer)'::regprocedure)) = '9c5c569556467e0bb71d4a0d6fe33990'

-- The first daily rollup cannot be overdue before its scheduled start and
-- configured execution budget. Keep older missing days and silence checks.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_rake_rollup_writer_silent(integer)'::regprocedure))
     NOT IN ('e4854fb8c73296006208ec3b97387c63','9c5c569556467e0bb71d4a0d6fe33990')
 OR NOT EXISTS (
  SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_rake_rollup_writer_silent(integer)'::regprocedure
   AND pg_get_userbyid(proowner)='postgres' AND prosecdef
   AND proconfig=ARRAY['search_path=public']
   AND proacl::text='{postgres=X/postgres,service_role=X/postgres}'
 ) OR NOT EXISTS (
  SELECT 1 FROM cron.job WHERE jobname='union-rake-rollup-catchup' AND active
   AND schedule='55 * * * *' AND command LIKE '%600s%'
   AND command LIKE '%fn_union_rake_rollup_catchup_all(8)%'
 ) THEN
  RAISE EXCEPTION 'Rollup monitor predecessor, authority, writer schedule or budget changed';
 END IF;
END $preflight$;
CREATE OR REPLACE FUNCTION public.fn_ca_rake_rollup_writer_silent(p_max_silence_hours integer DEFAULT 26)
 RETURNS TABLE(union_id uuid, last_write_at timestamp with time zone, hours_since_last_write numeric, newest_day_rolled date, newest_complete_day date, missing_complete_days integer, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH clock AS (
    SELECT now() AS checked_at
  ), bounds AS (
    SELECT checked_at,
           (checked_at AT TIME ZONE 'UTC')::date AS utc_today,
           ((checked_at AT TIME ZONE 'UTC') - interval '65 minutes')::date - 1 AS newest_due_day
      FROM clock
  ), totals AS (
    SELECT d.union_id AS uid, max(d.computed_at) AS last_write, max(d.day) AS newest_day
      FROM public.union_rake_rollup_days d
     GROUP BY d.union_id
  ), m AS (
    SELECT t.*,
           (SELECT count(*)::int
              FROM generate_series((b.utc_today - 7)::timestamp,
                                   b.newest_due_day::timestamp,
                                   interval '1 day') g(day)
             WHERE NOT EXISTS (SELECT 1 FROM public.union_rake_rollup_days x
                                WHERE x.union_id = t.uid AND x.day = g.day::date)) AS missing_days
      FROM totals t CROSS JOIN bounds b
  )
  SELECT m.uid, m.last_write,
         round((extract(epoch FROM (b.checked_at - m.last_write)) / 3600.0)::numeric, 2),
         m.newest_day, b.utc_today - 1, m.missing_days,
         'union_rake_rollup_days has not been written for '
           || round((extract(epoch FROM (b.checked_at - m.last_write)) / 3600.0)::numeric, 2)
           || ' hour(s) and ' || m.missing_days
           || ' due UTC day(s) in the last 7 completed days carry no rollup row '
           || '(newest day rolled: ' || COALESCE(m.newest_day::text, 'never')
           || ', newest completed day: ' || (b.utc_today - 1)::text
           || ', newest due day: ' || b.newest_due_day::text
           || '). Yesterday is due at 01:05 UTC: the first scheduled writer starts '
           || 'at 00:55 and has a 600-second execution budget. Older missing days '
           || 'and the configured silence threshold are checked throughout this window.'
    FROM m CROSS JOIN bounds b
   WHERE m.last_write < b.checked_at - make_interval(hours => GREATEST(p_max_silence_hours, 1))
      OR m.missing_days > 0
   ORDER BY 3 DESC
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_rake_rollup_writer_silent(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_rollup_writer_silent(integer) TO service_role;
DO $postflight$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_rake_rollup_writer_silent(integer)'::regprocedure)) <> '9c5c569556467e0bb71d4a0d6fe33990'
 OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_rake_rollup_writer_silent(integer)'::regprocedure
  AND pg_get_userbyid(proowner)='postgres' AND prosecdef
  AND proconfig=ARRAY['search_path=public']
  AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
  RAISE EXCEPTION 'Rollup monitor postimage or authority mismatch';
 END IF;
END $postflight$;
COMMIT;
