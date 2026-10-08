-- 20261007215818_a_failing_hourly_cron_reaches_the_board.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Replaces the 2026-10-01 drafts of PR #5730 (20261001152917 and
-- 20261001152926). The first (four covering indexes for the hourly
-- conservation sweep) is superseded: main fixed the sweep, which has completed
-- every run since 2026-10-04 in 40-58 s. The second restated
-- fn_ca_cron_failure_watch over md5 b0740121; main has since appended the
-- ledger-refusal watch (20261002135708, now 32c0a028), so restating the old
-- body would delete it. This edits today's live text in place instead and
-- keeps that block byte for byte.
--
-- A FAILING HOURLY CRON REACHES THE BOARD (2026-10-07). Detector only.
--
-- fn_ca_cron_failure_watch (cron ca-cron-health-30m) raises an incident only
-- for a job with >= 5 failures and 0 successes inside the last 2 HOURS. A job
-- that runs hourly can fail at most twice in two hours, so for every hourly or
-- slower job the rule can never fire. On 2026-09-27 ca-conservation-sweep-hourly
-- failed 23 of its 24 runs (each cancelled by statement_timeout, so the sweep
-- recorded nothing for any of its conservation checks), and the same blind spot
-- hid rake-bbj-invariant-audit-hourly (15 of 24), ca-settlement-correctness-30m
-- (13 of 24) and ca-guard-defs-hourly; nothing reached ca_drift_incidents or
-- operational_alert_events.
--
-- THE RULE NOW, independent of a job's cadence. An active job is failing when
--   (a) its three most recent finished runs all failed and it has not
--       succeeded in the last 2 hours (for a per-minute job that is the old
--       rule), or
--   (b) in the last 24 hours it failed at least 5 times and more often than
--       it succeeded (a job that times out on most runs but not all).
-- cron.job_run_details is read ONCE, bounded to the last 7 days (its only
-- index is the runid primary key, so a per-job "last three runs" lookup with no
-- time bound would scan the whole table once per active job). Everything else
-- is unchanged: incident source, dedup key per job per day, severity (critical
-- for an inventoried guard, else warning), routing through
-- fn_ca_raise_drift_incident, and the ledger-refusal block after the loop.
-- Read-only on production 2026-10-07: no active job meets either rule now, so
-- installing it raises nothing today; it is the next hourly outage that it sees.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261003082051. The
-- live text must hash to 32c0a028ed80fd1d277515790d0b446e, each of the two
-- anchors (the selection query and the incident text) must occur exactly once,
-- and the result must hash to f8657d84657bf72112cd07ae40798d73, derived
-- read-only on production with replace(). Owner, SECURITY DEFINER, proconfig
-- and grants must not move; the grant is then restated explicitly (production
-- already holds exactly this ACL). fn_ca_cron_failure_watch is on
-- fn_ca_guard_watchlist(), so the change is declared in this transaction.
--
-- Regression: scripts/ci/test-cron-failure-watch-reaches-the-board.py (native
-- PostgreSQL), run by .github/workflows/cron-failure-watch-reaches-the-board.yml.
--
-- @live-proof: SELECT md5(pg_get_functiondef('public.fn_ca_cron_failure_watch()'::regprocedure)) = 'f8657d84657bf72112cd07ae40798d73'
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_cron_failure_watch()',
  '32c0a028ed80fd1d277515790d0b446e', 'f8657d84657bf72112cd07ae40798d73',
  ARRAY[$o1$    SELECT j.jobname,
           count(*) FILTER (WHERE d.status = 'failed')    AS fails,
           count(*) FILTER (WHERE d.status = 'succeeded') AS successes,
           max(d.start_time) FILTER (WHERE d.status = 'succeeded') AS last_success,
           max(left(d.return_message, 200)) FILTER (WHERE d.status = 'failed') AS sample_error
    FROM cron.job j
    JOIN cron.job_run_details d ON d.jobid = j.jobid
    WHERE j.active AND d.start_time > now() - interval '2 hours'
    GROUP BY j.jobname
    HAVING count(*) FILTER (WHERE d.status = 'failed') >= 5
       AND count(*) FILTER (WHERE d.status = 'succeeded') = 0
    LIMIT 20
$o1$,
        $o2$      'scheduled job ' || r.jobname || ' has failed ' || r.fails
        || ' times in 2h with zero successes. Last error: ' || COALESCE(r.sample_error, '?'),
      NULL, jsonb_build_object('jobname', r.jobname, 'fails_2h', r.fails,
                               'last_success', r.last_success));
$o2$],
  ARRAY[$n1$    -- ONE pass over a bounded window. cron.job_run_details is indexed only by
    -- runid, so a per-job "last 3 runs" lookup with no time bound is a full
    -- scan per active job. Here a single scan of the last 7 days ranks each
    -- job's finished runs newest first; the 24 hour counts and the last three
    -- finished runs both come from that one pass. A job that appears in the
    -- 24 hour window runs at least daily, so its last three finished runs fall
    -- inside 7 days.
    WITH runs AS (
      SELECT d.jobid, d.status, d.start_time, d.return_message,
             d.start_time > now() - interval '24 hours' AS in_day,
             CASE WHEN d.status IN ('failed', 'succeeded')
                  THEN row_number() OVER (PARTITION BY d.jobid, d.status IN ('failed', 'succeeded')
                                          ORDER BY d.start_time DESC)
             END AS finished_rank
        FROM cron.job_run_details d
       WHERE d.start_time > now() - interval '7 days'
    ),
    day AS (
      SELECT j.jobid, j.jobname,
             count(*) FILTER (WHERE x.in_day AND x.status = 'failed')    AS fails,
             count(*) FILTER (WHERE x.in_day AND x.status = 'succeeded') AS successes,
             max(x.start_time) FILTER (WHERE x.in_day AND x.status = 'succeeded') AS last_success,
             max(left(x.return_message, 200)) FILTER (WHERE x.in_day AND x.status = 'failed') AS sample_error,
             count(*) FILTER (WHERE x.finished_rank <= 3) AS finished,
             count(*) FILTER (WHERE x.finished_rank <= 3 AND x.status = 'failed') AS failed_in_a_row
        FROM cron.job j
        JOIN runs x ON x.jobid = j.jobid
       WHERE j.active
       GROUP BY j.jobid, j.jobname
      HAVING count(*) FILTER (WHERE x.in_day) > 0
    )
    SELECT day.*
      FROM day
     WHERE (day.finished = 3 AND day.failed_in_a_row = 3
            AND (day.last_success IS NULL OR day.last_success <= now() - interval '2 hours'))
        OR (day.fails >= 5 AND day.fails > day.successes)
     ORDER BY day.fails DESC, day.jobname
     LIMIT 20
$n1$,
        $n2$      'scheduled job ' || r.jobname || ' failed ' || r.fails || ' of '
        || (r.fails + r.successes) || ' runs in 24h (last '
        || r.failed_in_a_row || ' of its last 3 failed; last success '
        || COALESCE(r.last_success::text, 'none in 24h') || '). Last error: '
        || COALESCE(r.sample_error, '?'),
      NULL, jsonb_build_object('jobname', r.jobname, 'fails_24h', r.fails,
                               'successes_24h', r.successes,
                               'failed_in_a_row', r.failed_in_a_row,
                               'last_success', r.last_success));
$n2$]
);

REVOKE ALL ON FUNCTION public.fn_ca_cron_failure_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_cron_failure_watch() TO service_role;

-- fn_ca_cron_failure_watch is on fn_ca_guard_watchlist(): declare the change in
-- this transaction so fn_ca_guard_defs_watch records it instead of raising it.
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_cron_failure_watch', 'migration 20261007215818_a_failing_hourly_cron_reaches_the_board');

COMMIT;
