# A migration dispatch never cancels another file (2026-10-24)

## What was wrong

`apply-merged-migration.yml` serialized every file through one concurrency
group: `apply-merged-migration`, with `cancel-in-progress: false`. In
GitHub's model a group holds one running run and ONE pending run. When a
newer run joins, GitHub cancels the pending one.

At 22:53:57-58Z three merges dispatched three different files within a
second. One run went to the queue. The other two were cancelled before they
started, with no job and no log. One of the dropped files was
`20261024213143_lightning_pilot_games_switch_off_so_the_horses_stand_up`. It
was merged and never applied. Nothing said so except the absence of a row in
`schema_migrations`.

## Fix

- **Per-file group.** The group is now
  `apply-merged-migration-<file>`. A duplicate dispatch of the same file
  still collapses, and different files no longer erase each other.
- **The one-at-a-time order.** It moved into the job as THE QUEUE. Before
  anything is sent, the apply step waits until no earlier run of this
  workflow is still queued or running. "Earlier" means a lower run id, so
  files apply one at a time in dispatch order.
- **Bounds.** The wait is capped at 600 s. A timeout, or an unreadable
  queue, ends REFUSED with nothing sent. It is never UNKNOWN, because
  nothing was sent.
- **Permissions.** The workflow gains `actions: read` to list its own runs.

## Pinned by

- `tests/unit/workflowConcurrencyGuard.test.ts` ("one migration dispatch
  never cancels another file")
- `scripts/ci/contract-index-recovery.test.mjs` (the group shape)
