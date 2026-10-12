# A cancelled Post-Deploy E2E client lane was only queued

## What was believed

Post-Deploy E2E runs kept ending `cancelled` (06:34, 06:42, 06:49 UTC on
2026-10-07), and the reading was that merges every few minutes cancel each
~40 minute client certificate before it finishes, so no client verdict could
ever complete.

## What the runs show

The client job's concurrency is `group: post-deploy-e2e-production`,
`cancel-in-progress: false`. Under that setting GitHub keeps one RUNNING job
and one PENDING job per group; a newer pending job replaces the older pending
one. The running job is never touched.

Every cancelled client lane between 04:00 and 07:25 UTC (nineteen of them)
has `runner_id: 0` and zero steps: it never left the queue. Every job that
took the lock ran to its own verdict:

| client job started         | finished | conclusion |
| -------------------------- | -------- | ---------- |
| 04:10:40 (run 37569802965) | 04:49:10 | failure    |
| 04:49:12 (run 37572996368) | 05:28:20 | failure    |
| 05:28:22 (run 37575691538) | 06:08:09 | failure    |
| 06:08:11 (run 37579424861) | 06:41:46 | failure    |
| 06:41:48 (run 37582208528) | 07:24:58 | failure    |
| 07:25:01 (run 37587015087) | 08:04:30 | success    |

The first five were real reds (the Financial Admin Settlement Center locator,
fixed in #6383), not cancellations. The sixth tested `fc01ed39ec`, which
contains #6383, and passed: 471 tests executed, 0 failed, and
`financial-admin.json` 4 of 4. A replaced queued job loses nothing: the job that
does run reads `build-info.json` when it starts and re-targets the whole suite
onto that commit (the `descendant` branch added 2026-09-30), so it covers every
commit it replaced, and the closing release-window step still refuses to
certify a release that changed underneath it.

## Decision

No concurrency change. `cancel-in-progress: true` would kill the running
certificate on every merge, which is the failure that was feared. The workflow
now carries the measurement beside the setting so the next reader does not
re-derive it, and `tests/unit/postDeployE2EConcurrency.test.ts` already pins
`cancel-in-progress: false`.
