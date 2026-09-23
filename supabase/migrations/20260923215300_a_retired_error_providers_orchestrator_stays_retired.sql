-- 20260923215300_a_retired_error_providers_orchestrator_stays_retired.sql
--
-- Production Alerts Fleet, operational_alert_events id=15
-- (OpenClawJobsHaveGoneSilent, firing continuously since 2026-09-12) and
-- id=11 (OpenClawFleetLongSilence, closed for its two known jobs by
-- Smarter-Poker-World-Hub#1963 and the detector fix in
-- 20260923175730_a_sparse_job_can_still_be_dead.sql, but not for this one).
--
-- Read live against production (2026-09-23) before writing this fix:
-- v_openclaw_job_staleness currently reports exactly three is_stale=true
-- jobs -- /cron/video-library-scraper (fixed in World Hub #1963, pending
-- merge), /cron/pokernews-videos (failing inside the smarter-poker-workers
-- repo, a different codebase this fleet has no access to), and:
--
--   job_name                     successes_30d  last_success_at        silent
--   /cron/clawbot-orchestrator              21  2026-09-15 07:00:00Z   8.6d
--
-- /cron/clawbot-orchestrator ran daily and "succeeded" for weeks, but its
-- one and only task (cron_execution_log.result->results->0, task_id
-- "cb-01-sentry-triage") had itself been erroring on every single run since
-- at least 2026-08-20 ("Failed to parse URL from /api/clawbot/sentry-triage"
-- -- a relative URL built with no base). It never did useful work in the
-- observed history.
--
-- What actually happened on 2026-09-15/16: World Hub PR #1812 ("Remove
-- external error telemetry from World Hub") formally retired the Sentry
-- error-tracking provider (2026-09-16 06:15:54 UTC) and, per its own
-- description, included "fix: retire provider-only worker dispatch
-- schedule" -- removing /api/clawbot/orchestrator from
-- scripts/openclaw-cron-dispatcher.py's ALL_CRONS. That repo's
-- __tests__/retired-error-provider.test.mjs now pins, by name, that the
-- dispatcher has no /api or /cron clawbot[/-]orchestrator entry at all.
-- clawbot-orchestrator's sole purpose was forwarding to the retired
-- provider; it was never repurposed, and its removal from the dispatcher
-- was correct and deliberate -- the job's last successful dispatch,
-- 2026-09-15 07:00:00 UTC, is exactly the run before that retirement
-- landed, and there has not been one since.
--
-- The gap: whoever shipped PR #1812 removed the dispatcher entry but never
-- added a row to ca_retired_cron_jobs, the registry v_openclaw_job_staleness
-- already checks (NOT EXISTS ... ca_retired_cron_jobs) to exclude a job that
-- was deliberately taken out of rotation. Without that row, the view has
-- spent eight days and counting treating a correctly-decommissioned job as
-- one that is unexpectedly going silent -- exactly the class of oversight
-- the five existing rows in this table were each added to fix (see
-- 20260827_horses_are_players_law.sql's siblings and this table's own
-- history for /cron/player-stats-refresh, /cron/trivia-pvp-cleanup, etc.).
--
-- THE FIX: register /cron/clawbot-orchestrator in ca_retired_cron_jobs.
-- No view or function changes needed -- the exclusion already exists and
-- takes effect the moment the row exists. Proved in a rolled-back probe
-- against production immediately before this migration: is_stale read true
-- before the insert and NULL (excluded from the view entirely) after,
-- confirmed via a self-aborting DO block per club-arena CLAUDE.md 11.5.
--
-- Idempotent: job_name is this table's primary key, so a second application
-- (e.g. if this lands alongside another agent's insert for the same job) is
-- a no-op rather than an error.

BEGIN;

INSERT INTO public.ca_retired_cron_jobs (job_name, retired_at, reason, replaced_by)
VALUES (
  '/cron/clawbot-orchestrator',
  '2026-09-16 06:15:54+00',
  'Retired from openclaw-cron-dispatcher.py''s ALL_CRONS on 2026-09-16 by '
  'World Hub PR #1812 ("Remove external error telemetry from World Hub" / '
  '"fix: retire provider-only worker dispatch schedule"), which decommissioned '
  'the Sentry error-tracking provider. clawbot-orchestrator''s only task was '
  'Sentry error triage (task_id cb-01-sentry-triage, forwarding to '
  '/api/clawbot/sentry-triage) and was never repurposed to anything else; '
  'that task had itself been erroring on every run since at least 2026-08-20 '
  '("Failed to parse URL from /api/clawbot/sentry-triage"), so the job never '
  'did useful work even while it was still being dispatched. World Hub main''s '
  '__tests__/retired-error-provider.test.mjs pins that the dispatcher carries '
  'no /api or /cron clawbot-orchestrator entry going forward. Last successful '
  'dispatch 2026-09-15 07:00:00 UTC, the day before retirement; zero runs '
  'since. Never registered here, so v_openclaw_job_staleness has treated a '
  'deliberately decommissioned job as one silently going stale for eight days, '
  'feeding false positives into operational_alert_events '
  '(OpenClawJobsHaveGoneSilent, OpenClawFleetLongSilence).',
  null
)
ON CONFLICT (job_name) DO NOTHING;

DO $assert_registered$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.ca_retired_cron_jobs
     WHERE job_name = '/cron/clawbot-orchestrator'
  ) THEN
    RAISE EXCEPTION 'clawbot-orchestrator retirement row did not install';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.v_openclaw_job_staleness
     WHERE job_name = '/cron/clawbot-orchestrator'
  ) THEN
    RAISE EXCEPTION 'clawbot-orchestrator is still visible to v_openclaw_job_staleness after registering it as retired';
  END IF;
END;
$assert_registered$;

COMMIT;
