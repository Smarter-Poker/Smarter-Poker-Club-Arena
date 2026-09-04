# CI was not slow. The boxes were thrashing.

## What was measured

The client unit job reported **12.4 minutes**. The same 911-file suite runs in
**31.9 seconds** on an unloaded 28-core machine. That 23x gap was never the
tests.

`vitest` defaults its thread pool to the machine's core count. That is correct
on a laptop that owns its CPU and wrong on a CI box that does not:

| runners        | cores | what one job claimed |
| -------------- | ----- | -------------------- |
| estate-ci-2: 8 | 8     | 8 threads, per job   |

Measured directly on estate-ci-2:

- **one** default run: 11 processes, load **12.05** on 8 cores
- **four** concurrent runs (what CI actually does): 41 processes, load **41.2**,
  into swap, and the box stopped accepting ssh until it was hard-reset

A job timing out on a collapsed box is indistinguishable from a job that
genuinely failed, which is part of why CI was failing 73 of 138 runs.

## The cap is close to free

Same suite, same machine, all 911 files passing:

| maxThreads    | wall  |
| ------------- | ----- |
| uncapped (28) | 33.2s |
| 4             | 36s   |
| 2             | 37s   |

Four seconds. The suite is dominated by fixed per-file environment
construction, not parallel width, so 28 threads buys almost nothing while
guaranteeing a stampede. CI now caps at 2; local runs stay uncapped.

## Also in this change

- **Live Production E2E → daily only.** It ran every 2 hours against a
  production that `post-deploy-e2e.yml` already exercises after every publish
  (~19 publishes an hour). Its distinct value is drift _not_ caused by a
  publish - a certificate, a Supabase change, a CDN regression - which does not
  need a 25-minute browser run twelve times a day. The two-hourly cron stays
  for `unit` and `server`: that is the "is main actually green" net, it is free
  on self-hosted runners, and shrinking it would widen broken-main detection
  from 2 hours to 24.
- **Dependency Audit → schedule-only.** It is `continue-on-error` and has never
  failed a build; it only writes a summary. It cost 2.2 of the 6.6 minutes of
  TypeScript Check on every pull request's critical path. It still audits main
  on the schedules above.
- **`auto-revert` job deleted.** Carried `if: false` since it was auto-reverting
  valid commits during the migration. Dead code occupying a job slot.

## What was NOT changed, deliberately

Both rulesets, the Silent Revert Guard, the Main Rewind Guard, every law test,
and all six required status checks are untouched. Nothing here weakens a guard;
it removes duplicated work.

**CSS Beat E2E stays on `ubuntu-latest`.** An earlier attempt to move it to the
box failed, and its own comment records why. It is a required check - routing it
speculatively would turn every merge red. Revisit once the boxes are no longer
oversubscribed.

A correction: an earlier pass through this file claimed CSS Beat installed
Playwright browsers twice. It does not. That is an if/else - self-hosted skips
`--with-deps` because the box already carries them.
