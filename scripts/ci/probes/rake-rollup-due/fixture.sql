CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobname text PRIMARY KEY,schedule text,active boolean,command text);
INSERT INTO cron.job VALUES('union-rake-rollup-catchup','55 * * * *',true,
 'DO $body$ BEGIN PERFORM set_config(''statement_timeout'',''600s'',true); PERFORM public.fn_union_rake_rollup_catchup_all(8); END $body$;');
CREATE TABLE public.union_rake_rollup_days(
 union_id uuid,day date,computed_at timestamptz,records_seen integer,PRIMARY KEY(union_id,day));
CREATE OR REPLACE FUNCTION public.fn_ca_rake_rollup_writer_silent(p_max_silence_hours integer DEFAULT 26)
 RETURNS TABLE(union_id uuid, last_write_at timestamp with time zone, hours_since_last_write numeric, newest_day_rolled date, newest_complete_day date, missing_complete_days integer, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH m AS (
    SELECT d.union_id AS uid,
           max(d.computed_at) AS last_write,
           max(d.day) AS newest_day,
           (SELECT count(*)::int
              FROM generate_series((current_date - 7)::timestamp,
                                   (current_date - 1)::timestamp,
                                   interval '1 day') g(day)
             WHERE NOT EXISTS (SELECT 1 FROM public.union_rake_rollup_days x
                                WHERE x.union_id = d.union_id
                                  AND x.day = g.day::date)) AS missing_days
      FROM public.union_rake_rollup_days d
     GROUP BY d.union_id
  )
  SELECT m.uid, m.last_write,
         round((extract(epoch FROM (now() - m.last_write)) / 3600.0)::numeric, 2),
         m.newest_day, (current_date - 1), m.missing_days,
         'union_rake_rollup_days has not been written for '
           || round((extract(epoch FROM (now() - m.last_write)) / 3600.0)::numeric, 2)
           || ' hour(s) and ' || m.missing_days
           || ' completed UTC day(s) in the last 7 carry no rollup row at all '
           || '(newest day rolled: ' || COALESCE(m.newest_day::text, 'never')
           || ', newest completed day: ' || (current_date - 1)::text
           || '). The writer is a pg_cron job on `55 * * * *`, so one completed '
           || 'day must be written every day; this is the shape that stayed 68 '
           || 'hours stale in September because the writer died on a '
           || 'statement_timeout where no cron.job_run_details row could record it'
    FROM m
   WHERE m.last_write < now() - make_interval(hours => GREATEST(p_max_silence_hours, 1))
      OR m.missing_days > 0
   ORDER BY 3 DESC
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_rake_rollup_writer_silent(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_rollup_writer_silent(integer) TO service_role;
