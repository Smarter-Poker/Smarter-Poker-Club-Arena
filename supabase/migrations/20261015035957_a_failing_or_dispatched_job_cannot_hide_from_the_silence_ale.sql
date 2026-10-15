-- 20261015035957_a_failing_or_dispatched_job_cannot_hide_from_the_silence_ale
--
-- Reserved by scripts/new-migration.mjs on 2026-10-15 03:59:57 UTC.
--
-- A FAILING OR DISPATCHED JOB CANNOT HIDE FROM THE SILENCE ALERTS (2026-10-15)
--
-- Re-derives the stale PR #5144 ("a sparse job's staleness detector never
-- expires", written against 2026-09-23 main) over current production, and
-- fixes the two other defects the same alerts were carrying.
--
-- 1. v_openclaw_job_staleness WENT BLIND IN TWO WAYS (OpenClawFleetLongSilence,
--    OpenClawJobsHaveGoneSilent). Read live 2026-10-15 04:0x UTC:
--      * is_stale required successes_30d >= 5, so a job that keeps being
--        dispatched and keeps failing decays below five successes and then
--        reads not stale for ever: /cron/pokernews-videos, 3 successes,
--        silent 15.1 days, is_stale false.
--      * the job universe was "had a SUCCESS in the last 30 days", so a job
--        with none disappears from the view entirely while the dispatcher
--        keeps firing it: /cron/video-library-scraper, 21 runs in 30 days,
--        0 successes (last success 2026-08-29), not in the view at all.
--    The view now starts from every job that RAN in the last 30 days (any
--    finished status). The cadence rule for jobs with >= 5 successes is
--    unchanged. Any other job is stale once it has been silent longer than
--    the cadence rule's own 10-day (14,400 minute) ceiling, measured from its
--    last success ever (or from its first run in the window if it never
--    succeeded), provided it had a success in the window or is still being
--    fired (two or more runs in the last 10 days). A job fired once and never
--    again (/cron/trivia-nightly-tournament: one run on 2026-10-05, its
--    schedule flag is off in the dispatcher) is not stale. Columns, types,
--    owner, ACL and security_invoker are unchanged; threshold_minutes now
--    shows 14400 for a sparse job, the threshold it is actually judged by.
--    Measured read-only: 402 ms before, 476 ms after.
--
-- 2. THE NO-OP DETECTOR READ ONLY SUCCESSES (CronJobsReportingSuccessWhileDoingNothing).
--    fn_monitoring_health_snapshot's noop count took each job's latest
--    SUCCESS, so a job that has failed ever since (pokernews-videos: HTTP 500
--    every 3 hours since 2026-09-30) stayed counted for 30 days on its last
--    skipped success. It now takes each job's latest finished run of any
--    status; only a latest run that is a success with a string skip reason
--    and no real work for 24 hours is counted. A run that reports `held`
--    (a deliberate owner hold, such as an approval gate left off on purpose:
--    workers /cron/phase9-content with hand_clip awaiting approval) is never
--    counted. The metric name and every other column are unchanged.
--
-- 3. TWO NAMES THAT ARE NOT LIVE JOBS ARE REGISTERED in ca_retired_cron_jobs,
--    the registry both readers already exclude (20260904185338):
--      * /cron/pokernews-videos: removed from the World Hub dispatcher by the
--        companion World Hub PR. No PokerNews content_author exists (the
--        importer refuses to attribute official items to a horse), its RSS
--        source now 404s, and the source registry already carries PokerNews
--        as an active source (public.content_sources 'PokerNews', handle
--        @PokerNews), so the work lives there. Last success 2026-09-30 00:30 UTC.
--      * /cron/__auth_probe_no_such_route__: the dispatcher's own auth probe
--        (scripts/openclaw-cron-dispatcher.py) deliberately requests a route
--        that does not exist; its 404 is its success. 12,492 rows, never a
--        job.
--
-- HOW: preimages pinned (view viewdef md5 085765e6..., snapshot md5
-- 35b5a40a...). The snapshot is the pinned-preimage substitution of
-- 20261007212545 with five anchors, each occurring exactly once, to the
-- postimage derived read-only on production with replace() (353ff5fc...).
-- Owner, SECURITY DEFINER, proconfig and grants must not move.
--
-- Regression: scripts/ci/test-a-silent-job-cannot-hide.py (native
-- PostgreSQL), run by .github/workflows/a-silent-job-cannot-hide.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_monitoring_health_snapshot(integer)'::regprocedure)) = '353ff5fc64d427d2ffd46582699c6300' AND pg_get_viewdef('public.v_openclaw_job_staleness'::regclass, true) LIKE '%fires_10d%' AND (SELECT count(*) FROM public.ca_retired_cron_jobs WHERE job_name IN ('/cron/pokernews-videos', '/cron/__auth_probe_no_such_route__')) = 2)

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_silence_subst(p_sig text, p_before text, p_after text,
                                         p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

CREATE TEMP TABLE ca_silence_view_before ON COMMIT DROP AS
  SELECT c.relacl::text AS acl, pg_get_userbyid(c.relowner) AS owner, c.reloptions::text AS opts,
         (SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum)
            FROM pg_attribute WHERE attrelid = c.oid AND attnum > 0) AS cols
    FROM pg_class c WHERE c.oid = 'public.v_openclaw_job_staleness'::regclass;

DO $pre$
BEGIN
  IF md5(pg_get_viewdef('public.v_openclaw_job_staleness'::regclass, true)) <> '085765e6587d63b90b2ae18f1ae65316' THEN
    RAISE EXCEPTION 'v_openclaw_job_staleness is not the pinned preimage (md5 %)',
      md5(pg_get_viewdef('public.v_openclaw_job_staleness'::regclass, true));
  END IF;
END
$pre$;

INSERT INTO public.ca_retired_cron_jobs (job_name, retired_at, reason, replaced_by)
VALUES
  ('/cron/pokernews-videos', '2026-09-30 00:30:01.347+00'::timestamptz,
   'Removed from the World Hub OpenClaw dispatcher on 2026-10-15. It returned HTTP 500 every 3 hours from 2026-09-30: no PokerNews content_author exists and the importer correctly refuses to attribute official items to a horse, and its RSS source now answers 404. PokerNews is already an active source in the content_sources registry (handle @PokerNews), so the work it duplicated lives there. Last success 2026-09-30 00:30 UTC.',
   'content_sources registry source PokerNews (@PokerNews)'),
  ('/cron/__auth_probe_no_such_route__', '2026-10-15 00:00:00+00'::timestamptz,
   'Not a job: the OpenClaw dispatcher''s own CRON_SECRET probe (scripts/openclaw-cron-dispatcher.py) deliberately requests this nonexistent workers route, and the 404 it logs is the outcome it wants. It has never succeeded and never will.',
   NULL)
ON CONFLICT (job_name) DO NOTHING;

CREATE OR REPLACE VIEW public.v_openclaw_job_staleness WITH (security_invoker = true) AS
 WITH s AS MATERIALIZED (
         SELECT cel.job_name,
            cel.started_at,
            lag(cel.started_at) OVER (PARTITION BY cel.job_name ORDER BY cel.started_at) AS prev_started_at
           FROM public.cron_execution_log cel
          WHERE cel.started_at > (now() - '30 days'::interval) AND cel.status = 'success'::text AND NOT (EXISTS ( SELECT 1
                   FROM public.ca_retired_cron_jobs r
                  WHERE r.job_name = cel.job_name))
        ), g AS (
         SELECT s.job_name,
            EXTRACT(epoch FROM s.started_at - s.prev_started_at) / 60.0 AS gap_minutes
           FROM s
          WHERE s.prev_started_at IS NOT NULL
        ), p AS MATERIALIZED (
         SELECT g.job_name,
            percentile_cont(0.9::double precision) WITHIN GROUP (ORDER BY (g.gap_minutes::double precision)) AS p90_gap_minutes
           FROM g
          GROUP BY g.job_name
        ), fired AS MATERIALIZED (
         SELECT cel.job_name,
            min(cel.started_at) AS first_seen_at,
            count(*) FILTER (WHERE cel.started_at > (now() - '10 days'::interval)) AS fires_10d
           FROM public.cron_execution_log cel
          WHERE cel.started_at > (now() - '30 days'::interval) AND cel.status <> 'running'::text AND NOT (EXISTS ( SELECT 1
                   FROM public.ca_retired_cron_jobs r
                  WHERE r.job_name = cel.job_name))
          GROUP BY cel.job_name
        ), agg AS MATERIALIZED (
         SELECT f.job_name,
            COALESCE(a30.last_success_at, ( SELECT max(c.started_at) AS max
                   FROM public.cron_execution_log c
                  WHERE c.job_name = f.job_name AND c.status = 'success'::text)) AS last_success_at,
            COALESCE(a30.successes_30d, 0::bigint) AS successes_30d,
            f.first_seen_at,
            f.fires_10d
           FROM fired f
             LEFT JOIN ( SELECT s.job_name,
                    max(s.started_at) AS last_success_at,
                    count(*) AS successes_30d
                   FROM s
                  GROUP BY s.job_name) a30 ON a30.job_name = f.job_name
        ), m AS (
         SELECT agg.job_name,
            agg.last_success_at,
            agg.successes_30d,
            agg.fires_10d,
            EXTRACT(epoch FROM now() - COALESCE(agg.last_success_at, agg.first_seen_at)) / 60.0 AS silent_minutes
           FROM agg
        )
 SELECT m.job_name,
    m.last_success_at,
    m.successes_30d,
    round(m.silent_minutes, 2) AS silent_minutes,
    round(p.p90_gap_minutes::numeric, 2) AS p90_gap_minutes,
    round(
        CASE
            WHEN m.successes_30d >= 5 THEN LEAST(GREATEST(2::double precision * p.p90_gap_minutes, 45::double precision), 14400::double precision)
            ELSE 14400::double precision
        END::numeric, 2) AS threshold_minutes,
    m.successes_30d >= 5 AND m.silent_minutes::double precision > LEAST(GREATEST(2::double precision * p.p90_gap_minutes, 45::double precision), 14400::double precision) OR m.silent_minutes > 14400::numeric AND (m.successes_30d > 0 OR m.fires_10d >= 2) AS is_stale
   FROM m
     LEFT JOIN p ON p.job_name = m.job_name;

DO $post$
DECLARE b record;
BEGIN
  SELECT * INTO STRICT b FROM ca_silence_view_before;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.oid = 'public.v_openclaw_job_staleness'::regclass
       AND c.relacl::text IS NOT DISTINCT FROM b.acl
       AND pg_get_userbyid(c.relowner) = b.owner
       AND c.reloptions::text IS NOT DISTINCT FROM b.opts
       AND (SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum)
              FROM pg_attribute WHERE attrelid = c.oid AND attnum > 0) = b.cols) THEN
    RAISE EXCEPTION 'v_openclaw_job_staleness changed owner, grants, options or columns';
  END IF;
  IF (SELECT count(*) FROM public.ca_retired_cron_jobs
       WHERE job_name IN ('/cron/pokernews-videos', '/cron/__auth_probe_no_such_route__')) <> 2 THEN
    RAISE EXCEPTION 'expected both names registered';
  END IF;
END
$post$;

SELECT pg_temp.ca_silence_subst(
  'public.fn_monitoring_health_snapshot(integer)',
  '35b5a40a7aee5d616dff26d695fe8497', '353ff5fc64d427d2ffd46582699c6300',
  ARRAY[$o0$  ), runs AS MATERIALIZED (
    SELECT job_name, started_at, result,
$o0$,
$o1$       AND status = 'success'
$o1$,
$o2$    SELECT DISTINCT ON (job_name) job_name, result
$o2$,
$o3$FROM runs WHERE did_work GROUP BY 1$o3$,
$o4$     WHERE l.result ? 'skipped'
$o4$],
  ARRAY[$n0$  ), runs AS MATERIALIZED (
    -- EVERY FINISHED RUN, NOT ONLY THE SUCCESSES (2026-10-15). A job whose
    -- latest run failed is not reporting success; reading only successes
    -- kept a job that now fails (pokernews-videos, 500 since 2026-09-30)
    -- counted for 30 days on its last skipped success. A run that reports
    -- held is a deliberate owner hold (an approval gate left off on
    -- purpose), not success while doing nothing, and is never counted.
    SELECT job_name, started_at, status, result,
$n0$,
$n1$       AND status <> 'running'
$n1$,
$n2$    SELECT DISTINCT ON (job_name) job_name, status, result
$n2$,
$n3$FROM runs WHERE did_work AND status = 'success' GROUP BY 1$n3$,
$n4$     WHERE l.status = 'success'
       AND NOT (l.result ? 'held')
       AND l.result ? 'skipped'
$n4$]
);

COMMIT;
