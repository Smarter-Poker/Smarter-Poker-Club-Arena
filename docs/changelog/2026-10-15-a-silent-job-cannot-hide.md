# A Silent Job Cannot Hide From The Silence Alerts

## What Was Wrong

- `v_openclaw_job_staleness` judged only jobs with five or more successes in
  30 days, so a job that keeps being dispatched and keeps failing decays out
  of judgement (`/cron/pokernews-videos`: 3 successes, silent 15 days, not
  stale). Its job list was "had a success in 30 days", so a job with none
  vanished while still being fired (`/cron/video-library-scraper`: 21 runs,
  0 successes). This re-derives the stale PR #5144 over current production.
- `fn_monitoring_health_snapshot` counted a job as succeeding while doing
  nothing from its latest success, so a job that has failed ever since stayed
  counted for 30 days, and it had no notion of a deliberate owner hold.

## The Fix

Migration `20261015035957_a_failing_or_dispatched_job_cannot_hide_from_the_silence_ale`:

- The staleness view starts from every job that ran in 30 days. Jobs with five
  or more successes keep their cadence rule; any other job is stale once
  silent past the same 10-day ceiling, if it succeeded in the window or is
  still being fired.
- The no-op count reads each job's latest finished run of any status and never
  counts a run that reports `held`.
- `/cron/pokernews-videos` (removed from the World Hub dispatcher; PokerNews
  is an active `content_sources` registry source, handle `@PokerNews`) and the
  dispatcher's own auth probe route are registered in `ca_retired_cron_jobs`.

## Pinned By

`scripts/ci/test-a-silent-job-cannot-hide.py` on native PostgreSQL (workflow
`a-silent-job-cannot-hide.yml`).
