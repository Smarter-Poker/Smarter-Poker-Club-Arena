# A retired error provider's orchestrator stays retired

Production Alerts board incident: `operational_alert_events` id=15
(`OpenClawJobsHaveGoneSilent`, firing continuously since 2026-09-12) and, in
part, id=11 (`OpenClawFleetLongSilence`).

## What was actually happening

`v_openclaw_job_staleness` currently reports exactly three `is_stale=true`
jobs:

| job_name | successes_30d | last_success_at | silent |
|---|---|---|---|
| `/cron/video-library-scraper` | 5 | 2026-08-29 06:00:08Z | 25.6d |
| `/cron/pokernews-videos` | varies | recent, but every run errors | ongoing |
| `/cron/clawbot-orchestrator` | 21 | 2026-09-15 07:00:00Z | 8.6d |

The first is root-caused and fixed in `Smarter-Poker-World-Hub#1963` (a
missing report-back webhook). The second fails inside the `smarter-poker-workers`
repo (a `content_author is not configured` guard and an `RSS fetch ... 404`),
a different codebase this fleet has no repository access to -- left open,
analogous to the already-documented `daily-challenges` case deferred until
the workers repo owner reconciles it.

The third, `/cron/clawbot-orchestrator`, is this fix.

## Root cause

`clawbot-orchestrator` ran daily and its overall job status read `success`
for weeks, but its one and only task (`task_id: cb-01-sentry-triage`,
forwarding to `/api/clawbot/sentry-triage`) had itself been erroring on every
run since at least 2026-08-20 (`"Failed to parse URL from
/api/clawbot/sentry-triage"` -- a relative URL built with no base). It never
did useful work in the observed history.

On 2026-09-16, World Hub PR #1812 ("Remove external error telemetry from
World Hub") formally retired the Sentry error-tracking provider and, per its
own description, included "fix: retire provider-only worker dispatch
schedule" -- removing `/api/clawbot/orchestrator` from
`scripts/openclaw-cron-dispatcher.py`'s `ALL_CRONS`. That repo's
`__tests__/retired-error-provider.test.mjs` now pins, by name, that the
dispatcher carries no `/api` or `/cron` `clawbot[/-]orchestrator` entry at
all. The job's last successful dispatch, 2026-09-15 07:00:00 UTC, is exactly
the run before that retirement landed, and there has been none since. This
was correct and deliberate.

The gap: whoever shipped PR #1812 removed the dispatcher entry but never
added a row to `ca_retired_cron_jobs` -- the registry
`v_openclaw_job_staleness` already checks (`NOT EXISTS ...
ca_retired_cron_jobs`) to exclude a job that was deliberately taken out of
rotation. Without that row, the view spent eight days and counting treating
a correctly-decommissioned job as one unexpectedly going silent, feeding
false positives into `OpenClawJobsHaveGoneSilent` and
`OpenClawFleetLongSilence`.

## Fix

`supabase/migrations/20260923215300_a_retired_error_providers_orchestrator_stays_retired.sql`
registers `/cron/clawbot-orchestrator` in `ca_retired_cron_jobs`. No view or
function change needed -- the exclusion already exists and takes effect the
moment the row exists.

Proved in a rolled-back probe against production immediately before writing
the migration (CLAUDE.md 11.5): `is_stale` read `true` before the insert and
the job disappeared from the view entirely (no row) immediately after, all
inside one self-aborting `DO` block.

## Hardening

- **Root cause fixed**: the missing registry row, not a new sweep or a
  widened threshold.
- **Damage**: none to settle -- this is a read-only monitoring registry, no
  money or player state.
- **Regression test**:
  `server/src/observability/ARetiredErrorProvidersOrchestratorStaysRetired.guard.test.ts`
  pins the exact insert, its idempotency, and both assertions.
- **Detection**: none needed -- `OpenClawJobsHaveGoneSilent` and
  `OpenClawFleetLongSilence` are the existing detectors; they will now
  correctly stop counting this job at all.

## Scope note

`/cron/pokernews-videos` remains open -- its failure lives in the
`smarter-poker-workers` repository, outside this session's repository
access.
