# The watchdog was cancelling its own deploy (2026-09-09)

## What was seen

At 20:54 UTC `engine.smarter.poker/health` reported `version: 5dd902e9`, a
17:29 commit that was cut over in the 17:55 break. Nine engine commits had
merged since, the first at 17:39. The 18:55 and 19:55 breaks both passed with
no cutover. The engine was three hours behind `main` on the busiest afternoon
of the week, and every run of the deploy workflow in that stretch was either
cancelled or had shipped nothing.

The client bundle was fine the whole time: `ca-static.smarter.poker` and the
World Hub rewrite `/hub/club-arena/` both served `main` HEAD (`b30e1b85`) four
minutes after it merged. Only the Hetzner path was stuck.

## Why

`.github/scripts/engine-watchdog.sh` step 5 dispatched
`auto-deploy-hetzner.yml` unconditionally whenever the engine was behind and
past its grace. That job runs on **every completion of the publisher** plus two
crons (`:19`, `:42`) - eight or more times an hour on a busy afternoon.

`auto-deploy-hetzner.yml` uses `concurrency: { group: deploy-hetzner,
cancel-in-progress: false }`. GitHub keeps one run active and **one** pending
in that group, and each new run entering the group cancels the older pending
one. That is the documented behaviour and it is correct - a superseded pending
run is superseded.

Put together: while the engine was behind, every sweep dispatched a fresh run,
and every fresh run cancelled the run that was sitting in the break gate
waiting for `:55`. Then the fresh run took its place in the gate, and the next
sweep cancelled it. The watchdog was the thing keeping the engine from
catching up, and its own log said "dispatched" about twenty times.

The client-side `publish-watchdog.sh` already had the guard this one lacked
(`in_progress` is trusted, `queued` is trusted up to a budget).
`schedule-liveness.mjs` has it too (`busy` -> do not dispatch). The engine
watchdog was the one dispatcher in the repo without one.

## What changed

`.github/scripts/engine-watchdog.sh`:

1. **One deploy at a time.** Before dispatching, list the deploy workflow's
   runs and take the newest one that is not `completed` and is younger than
   `INFLIGHT_STALE_MIN` (65 = the job's 55-minute ceiling plus a margin). If
   one exists, do not dispatch: that run is the fix, and the issue records
   exactly which run and why. A run older than the ceiling is one GitHub has
   timed out or a pre-queued zombie, and a dispatch is the right answer again.
2. **One progress comment per `COMMENT_EVERY_MIN` (30), not one per sweep.**
   Forty "Still behind" comments in three hours buried the table that says
   why. The alarm is raised once; progress is reported on a clock.

`tests/engine-watchdog-asks-production.test.ts` pins both: the dispatch is the
`elif` of finding a run in flight, the `gh run list` precedes the
`gh workflow run`, and the comment throttle exists.

## What did not change

- `auto-deploy-hetzner.yml`'s concurrency. Cancelling a superseded _pending_
  run is right. The bug was the dispatcher, not the group.
- No `force: true` was dispatched at any point. The engine catches up inside
  the next announced break, on tables with no cards in the air, as designed.
- Horse Brain logic, the break clock, the grace arithmetic - untouched.

## How to see it working

On the next sweep while a deploy is in flight, the engine job's log reads
`not dispatching: a deploy run is already in flight (<id> <status> <sha>
<event> <age>m <url>)` and the issue's `deploy dispatched by this run` row
names that run instead of claiming a new one.
