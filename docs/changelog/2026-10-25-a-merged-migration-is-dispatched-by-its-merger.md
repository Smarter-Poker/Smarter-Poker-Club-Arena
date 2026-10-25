# A merged migration is dispatched by its merger (2026-10-25)

## What happened

PR #7971 added
`supabase/migrations/20261024231549_lightning_voided_hand_returns_its_blind_stamps.sql`.
The autopilot App armed protected squash auto-merge at 00:22 UTC and GitHub
completed the merge as `smarter-poker-autopilot[bot]` at 01:48:24 UTC. Nothing
dispatched `apply-merged-migration.yml`, so the file sat on `main` and absent
from `schema_migrations` until an agent dispatched it by hand at 02:30 UTC
(run 40154674704, applied 02:34 UTC).

## Why

`apply-merged-migration.yml` is dispatch-only on purpose: "THE READER is the
person who dispatches it". That holds when a person merges. When the
autopilot merges, no person is there, and nothing in the merge path ever sent
the dispatch. Every migration from an automatically merged PR was left
uninstalled until somebody noticed.

## The fix

The merger now dispatches its own merge. `agent-autopilot.yml` also listens for
the native `pull_request_target` `closed` event. A new job,
`dispatch-merged-migrations`, runs only when the PR merged into the default
branch from a branch in this repository. It mints the same App token, and
`.github/scripts/dispatch-merged-migrations.sh` only acts when
`merged_by` is the autopilot App itself. A PR a person merged still has that
person as the reader.

Merges happen in two places: `queue-pr.sh` either arms auto-merge, in which case
GitHub completes it later as the App, or merges directly once the PR is clean.
The `closed` event covers both, and it is the merge job's own workflow acting on
its own merge. It is not a watcher or a schedule.

For each file the PR added under `supabase/migrations/` that has the applier's
filename shape, the job sends one `repository_dispatch` in filename order
(`event_type=apply-merged-migration`, `client_payload {migration, dry_run: false}`).
Each one is sent once and never retried. If GitHub refuses a send, the job
stops, names the files still to send in the summary and on the PR, and fails.

- **Window files are skipped.** A file carrying
  `-- @install-window: daily-maintenance` (classified by the applier's own
  `windowDeclaration`) is named in the summary as queued for
  `stage-engine-release.yml`'s window-migrations job. This door never sends it.
- **The break window: wait once, with a limit, before sending.** The applier
  refuses at minute :50-:03 UTC. The database also refuses through the daily
  04:00 America/Chicago break and its release. A dispatch sent into either one
  leaves the file uninstalled, which is the same defect again. So the planner
  (`scripts/ci/merged-migration-dispatch.mjs`) finds the first moment the
  applier will accept every file. That moment is :04 or later, with runway
  before :50 (12 more minutes for a CONCURRENTLY preamble), and outside
  03:50-04:10 Chicago. The job sleeps until then, at most 22 minutes, and
  checks the clock once more before sending anything. 22 minutes covers every
  ordinary file merged at any minute of the day. The worst cases are 15 minutes
  for a merge at :49 and 20 minutes for one at 03:50 Chicago. The job timeout
  is 30 minutes. If a file cannot be accepted within that limit, the job sends
  nothing. It names every file in the job summary and in a PR comment, and the
  run fails. Only a preamble file merged late in the hour can hit this case.
  No file is left behind silently.
- **Merged runs get their own concurrency group, and nothing cancels them.**
  Otherwise the `closed` run would cancel the queue run that had just merged
  the PR, and a new event could cut its wait short.

`apply-merged-migration.yml` is unchanged. It is still dispatch-only, and every
guard it runs is the same.

PR #7971 under the new path: merged 01:48:24 UTC, wait to 02:04 UTC, one dispatch.

## Pinned by

`tests/a-merged-migration-is-dispatched-by-its-merger.law.test.ts`
(`docs/laws.d/a-merged-migration-is-dispatched-by-its-merger.md`).
`tests/unit/autopilotRearmsAfterCi.test.ts` pins the new concurrency
expression in the same commit.

## Estate note

`agent-autopilot.yml` is listed in `SHARED_FILES` in
`.github/scripts/estate-integrity.sh`. The new job checks first for
`.github/scripts/dispatch-merged-migrations.sh` and does nothing in a
repository that lacks it, so the same bytes are safe in every repository. The
estate audit will show this copy as differing until the other repositories
take it.
